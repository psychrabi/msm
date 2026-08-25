use std::{collections::HashSet, time::Duration};

use tokio::{net::TcpStream, time::sleep};
use tracing::{info, warn};

use crate::{
    AppState, FIRST_VNC_PORT, RemoteSession, allocate_worker_port, discover_windows_sessions,
    spawn_worker, terminate_worker,
};

const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(2);
const WORKER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const WORKER_READY_POLL: Duration = Duration::from_millis(100);
const SUPERVISOR_RESTART_DELAY: Duration = Duration::from_secs(1);

pub async fn run(state: AppState) {
    info!("session supervisor started");

    loop {
        let reconcile_task = tokio::spawn(reconcile(state.clone()));

        match reconcile_task.await {
            Ok(()) => {}
            Err(error) if error.is_panic() => {
                warn!("session supervisor reconciliation panicked; restarting");
            }
            Err(error) => {
                warn!(%error, "session supervisor reconciliation task was cancelled; restarting");
            }
        }

        sleep(SUPERVISOR_RESTART_DELAY).await;
    }
}

pub async fn ensure_session(
    state: &AppState,
    session_id: u32,
) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    let _operation = state.worker_operations.lock().await;

    if let Some(existing) = state.workers.lock().await.get(&session_id).cloned() {
        // The process itself is authoritative. Checking the VNC socket alone can
        // produce a false positive if another process happens to own the port.
        let process_alive = is_process_alive(existing.worker_pid);
        let port_ready = TcpStream::connect(("127.0.0.1", existing.port))
            .await
            .is_ok();

        if process_alive && port_ready {
            return Ok(existing);
        }

        warn!(
            session_id,
            worker_pid = existing.worker_pid,
            port = existing.port,
            process_alive,
            port_ready,
            "VNC worker is unhealthy; restarting"
        );

        if process_alive {
            terminate_worker(existing.worker_pid);
        }
        state.workers.lock().await.remove(&session_id);
    }

    let port = {
        let workers = state.workers.lock().await;
        allocate_worker_port(&workers, FIRST_VNC_PORT)
    }
    .ok_or_else(|| "no available VNC worker ports".to_string())?;

    let password = state.auth_token.chars().take(8).collect::<String>();
    let worker_pid = spawn_worker(session_id, port, &password)?;

    info!(session_id, worker_pid, port, "started VNC worker");

    let deadline = tokio::time::Instant::now() + WORKER_READY_TIMEOUT;
    loop {
        if !is_process_alive(worker_pid) {
            return Err(format!(
                "VNC worker for session {session_id} exited before becoming ready"
            )
            .into());
        }

        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            let session = RemoteSession {
                session_id: session_id.to_string(),
                port,
                vnc_password: password,
                worker_pid,
            };
            state
                .workers
                .lock()
                .await
                .insert(session_id, session.clone());
            info!(session_id, worker_pid, port, "VNC worker ready");
            return Ok(session);
        }

        if tokio::time::Instant::now() >= deadline {
            terminate_worker(worker_pid);
            return Err(format!("VNC worker for session {session_id} did not become ready").into());
        }
        sleep(WORKER_READY_POLL).await;
    }
}

async fn reconcile(state: AppState) {
    let active_sessions = discover_windows_sessions().await;
    let active_ids: HashSet<u32> = active_sessions
        .iter()
        .filter_map(|session| session.session_id.parse().ok())
        .collect();

    // Reconcile every active session against the actual worker process. This is
    // deliberately process-based rather than worker-report-based: if a worker is
    // killed with Stop-Process or crashes, the master service can recreate it.
    for session_id in &active_ids {
        if let Err(error) = ensure_session(&state, *session_id).await {
            warn!(session_id, %error, "failed to ensure VNC worker");
        }
    }

    let stale: Vec<(u32, u32)> = {
        let workers = state.workers.lock().await;
        workers
            .iter()
            .filter_map(|(session_id, worker)| {
                (!active_ids.contains(session_id)).then_some((*session_id, worker.worker_pid))
            })
            .collect()
    };

    if !stale.is_empty() {
        let mut workers = state.workers.lock().await;
        for (session_id, worker_pid) in stale {
            terminate_worker(worker_pid);
            workers.remove(&session_id);
            info!(
                session_id,
                worker_pid, "removed worker for inactive session"
            );
        }
    }

    sleep(SUPERVISOR_INTERVAL).await;
}

/// Checks the Windows process itself rather than relying on the VNC TCP port.
/// This matches the proven watchdog behavior of the previous VNC service:
/// a worker is considered healthy only while its PID is still running.
fn is_process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        const STILL_ACTIVE: u32 = 259;

        unsafe {
            let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(handle) => handle,
                Err(_) => return false,
            };

            let mut exit_code = 0u32;
            let result = GetExitCodeProcess(handle, &mut exit_code).is_ok();
            let _ = CloseHandle(handle);
            result && exit_code == STILL_ACTIVE
        }
    }

    #[cfg(not(windows))]
    {
        let _ = pid;
        true
    }
}
