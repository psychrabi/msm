use std::{collections::HashSet, time::Duration};

use tokio::{net::TcpStream, time::sleep};
use tracing::{error, info, warn};

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
        let result = tokio::spawn(reconcile(state.clone())).await;
        match result {
            Ok(()) => {}
            Err(error) if error.is_panic() => {
                error!("session supervisor reconciliation panicked; restarting");
            }
            Err(error) => {
                error!(%error, "session supervisor reconciliation task was cancelled; restarting");
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
        let process_alive = is_process_alive(existing.worker_pid);
        let port_ready = TcpStream::connect(("127.0.0.1", existing.port)).await.is_ok();

        if process_alive && port_ready {
            return Ok(existing);
        }

        warn!(
            session_id,
            worker_pid = existing.worker_pid,
            port = existing.port,
            process_alive,
            port_ready,
            "worker is unhealthy; service will replace it"
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

    info!(session_id, worker_pid, port, "service spawned VNC worker");

    let deadline = tokio::time::Instant::now() + WORKER_READY_TIMEOUT;
    loop {
        if !is_process_alive(worker_pid) {
            warn!(session_id, worker_pid, "worker exited before becoming ready");
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
            info!(session_id, worker_pid, port, "service confirmed VNC worker ready");
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
    // First discover sessions. The supervisor treats an empty result as a valid
    // result only when the Windows enumeration itself succeeded. This prevents a
    // transient WTS enumeration failure from making the service delete its worker
    // registry and losing the ability to respawn a crashed worker.
    let sessions_ok = windows_session_enumeration_succeeded();
    let active_sessions = discover_windows_sessions().await;
    let active_ids: HashSet<u32> = active_sessions
        .iter()
        .filter_map(|session| session.session_id.parse().ok())
        .collect();

    if !sessions_ok {
        warn!("WTS session enumeration failed; preserving existing workers for this cycle");
    }

    // The service owns worker lifetime. Every active session is reconciled against
    // the actual worker PID, so killing msm-agent-worker.exe is sufficient to make
    // the service create a replacement on the next watchdog pass.
    for session_id in &active_ids {
        match ensure_session(&state, *session_id).await {
            Ok(session) => info!(
                session_id,
                worker_pid = session.worker_pid,
                port = session.port,
                "worker lifecycle reconciled"
            ),
            Err(error) => warn!(session_id, %error, "failed to ensure VNC worker"),
        }
    }

    // If a worker died between reconciliation passes, ensure_session above will
    // replace it. If session enumeration failed, do NOT remove anything based on
    // an empty list. If enumeration succeeded, remove only workers belonging to
    // sessions that really are no longer active (logout).
    if sessions_ok {
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
                info!(session_id, worker_pid, "removed worker for logged-out session");
            }
        }
    }

    sleep(SUPERVISOR_INTERVAL).await;
}

/// Check WTS independently so a failed enumeration cannot be mistaken for
/// "there are no logged-in users". The service account is expected to have the
/// required rights because this code runs inside the SYSTEM Windows service.
fn windows_session_enumeration_succeeded() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::System::RemoteDesktop::{
            WTS_CURRENT_SERVER_HANDLE, WTSFreeMemory, WTS_SESSION_INFOW, WTSEnumerateSessionsW,
        };

        unsafe {
            let mut sessions_ptr: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
            let mut count = 0u32;
            let result = WTSEnumerateSessionsW(
                Some(WTS_CURRENT_SERVER_HANDLE),
                0,
                1,
                &mut sessions_ptr,
                &mut count,
            )
            .is_ok();

            if !sessions_ptr.is_null() {
                WTSFreeMemory(sessions_ptr as _);
            }
            result
        }
    }

    #[cfg(not(windows))]
    {
        true
    }
}

/// Checks the Windows process itself rather than relying on the VNC TCP port.
/// This is the authoritative watchdog signal: a worker with a dead PID is dead,
/// even if its TCP port happens to remain temporarily open.
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
                Err(error) => {
                    warn!(pid, %error, "worker PID cannot be opened; treating it as dead");
                    return false;
                }
            };

            let mut exit_code = 0u32;
            let result = GetExitCodeProcess(handle, &mut exit_code).is_ok();
            let _ = CloseHandle(handle);

            if !result {
                warn!(pid, "GetExitCodeProcess failed; treating worker as dead");
                return false;
            }

            let alive = exit_code == STILL_ACTIVE;
            if !alive {
                info!(pid, exit_code, "worker process has exited");
            }
            alive
        }
    }

    #[cfg(not(windows))]
    {
        let _ = pid;
        true
    }
}
