use std::{collections::HashSet, net::TcpStream, thread, time::Duration};

use tokio::time::sleep;
use tracing::{info, warn};

use crate::{
    AppState, FIRST_VNC_PORT, RemoteSession, allocate_worker_port, spawn_worker, terminate_worker,
};

const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(3);
const WORKER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const WORKER_READY_POLL: Duration = Duration::from_millis(100);

/// Starts the service-owned worker watchdog on a dedicated OS thread.
///
/// The watchdog deliberately does not depend on the Tokio runtime. The Windows
/// service is the lifecycle owner of every per-session worker, so the watchdog
/// must continue running independently of HTTP/WebSocket activity.
pub fn start(state: AppState) {
    thread::Builder::new()
        .name("msm-session-supervisor".to_owned())
        .spawn(move || run_watchdog(state))
        .expect("failed to start MSM session supervisor thread");
}

fn run_watchdog(state: AppState) {
    info!("MSM session supervisor started");

    loop {
        reconcile_sync(&state);
        thread::sleep(SUPERVISOR_INTERVAL);
    }
}

/// Reconciles Windows interactive sessions with the service-owned worker registry.
///
/// This intentionally follows the proven ASTER/VNC model: enumerate sessions,
/// remove dead workers, remove workers for logged-out sessions, then spawn a
/// worker for every active session that has no live worker. A transient WTS
/// enumeration failure never causes the registry to be cleared.
fn reconcile_sync(state: &AppState) {
    let sessions = match enumerate_windows_sessions() {
        Ok(sessions) => sessions,
        Err(error) => {
            warn!(%error, "WTS session enumeration failed; preserving worker registry");
            return;
        }
    };

    let active_ids: HashSet<u32> = sessions.iter().map(|session| session.session_id).collect();

    // First remove workers whose processes actually died. This is the critical
    // respawn path: Stop-Process/crash -> PID is no longer alive -> registry entry
    // disappears -> the spawn pass below immediately recreates the worker.
    {
        let mut workers = state.workers.blocking_lock();
        workers.retain(|session_id, worker| {
            if is_process_alive(worker.worker_pid) {
                true
            } else {
                warn!(
                    session_id,
                    worker_pid = worker.worker_pid,
                    "worker process died; scheduling respawn"
                );
                false
            }
        });
    }

    // Remove workers belonging to sessions that really logged out. This is only
    // performed after a successful WTS enumeration.
    {
        let mut workers = state.workers.blocking_lock();
        let stale: Vec<(u32, u32)> = workers
            .iter()
            .filter_map(|(session_id, worker)| {
                (!active_ids.contains(session_id)).then_some((*session_id, worker.worker_pid))
            })
            .collect();

        for (session_id, worker_pid) in stale {
            info!(session_id, worker_pid, "session logged out; terminating worker");
            terminate_worker(worker_pid);
            workers.remove(&session_id);
        }
    }

    // Finally ensure every active session has a worker. This includes sessions
    // whose previous worker was just detected as dead above.
    for session in sessions {
        let needs_worker = {
            let workers = state.workers.blocking_lock();
            match workers.get(&session.session_id) {
                Some(worker) => !is_process_alive(worker.worker_pid),
                None => true,
            }
        };

        if needs_worker {
            if let Err(error) = spawn_worker_for_session(state, &session) {
                warn!(
                    session_id = session.session_id,
                    username = %session.username,
                    %error,
                    "failed to spawn session worker; will retry on next watchdog pass"
                );
            }
        }
    }
}

fn spawn_worker_for_session(
    state: &AppState,
    session: &SessionInfo,
) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    let _operation = state.worker_operations.blocking_lock();

    // Re-check after acquiring the lifecycle lock so a viewer request and the
    // watchdog cannot create two workers for the same session concurrently.
    if let Some(existing) = state.workers.blocking_lock().get(&session.session_id).cloned() {
        if is_process_alive(existing.worker_pid) {
            return Ok(existing);
        }
        terminate_worker(existing.worker_pid);
        state.workers.blocking_lock().remove(&session.session_id);
    }

    let port = {
        let workers = state.workers.blocking_lock();
        allocate_worker_port(&workers, FIRST_VNC_PORT)
    }
    .ok_or_else(|| "no available VNC worker ports".to_string())?;

    let password = state.auth_token.chars().take(8).collect::<String>();
    let worker_pid = spawn_worker(session.session_id, port, &password)?;

    info!(
        session_id = session.session_id,
        username = %session.username,
        worker_pid,
        port,
        "spawned VNC session worker"
    );

    // Give the worker a short opportunity to bind its VNC port. The PID remains
    // authoritative; a worker that exits during this wait is simply not
    // registered and will be retried by the next watchdog pass.
    let deadline = std::time::Instant::now() + WORKER_READY_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if !is_process_alive(worker_pid) {
            return Err(format!(
                "worker PID {worker_pid} exited before becoming ready"
            )
            .into());
        }

        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            WORKER_READY_POLL,
        )
        .is_ok()
        {
            let remote_session = RemoteSession {
                session_id: session.session_id.to_string(),
                port,
                vnc_password: password,
                worker_pid,
            };
            state
                .workers
                .blocking_lock()
                .insert(session.session_id, remote_session.clone());
            return Ok(remote_session);
        }

        thread::sleep(WORKER_READY_POLL);
    }

    terminate_worker(worker_pid);
    Err(format!("worker PID {worker_pid} did not become ready on port {port}").into())
}

pub async fn ensure_session(
    state: &AppState,
    session_id: u32,
) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    let _operation = state.worker_operations.lock().await;

    if let Some(existing) = state.workers.lock().await.get(&session_id).cloned() {
        let process_alive = is_process_alive(existing.worker_pid);
        let port_ready = tokio::net::TcpStream::connect(("127.0.0.1", existing.port))
            .await
            .is_ok();

        if process_alive && port_ready {
            return Ok(existing);
        }

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

    let deadline = tokio::time::Instant::now() + WORKER_READY_TIMEOUT;
    loop {
        if !is_process_alive(worker_pid) {
            return Err(format!(
                "VNC worker for session {session_id} exited before becoming ready"
            )
            .into());
        }

        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
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
            return Ok(session);
        }

        if tokio::time::Instant::now() >= deadline {
            terminate_worker(worker_pid);
            return Err(format!("VNC worker for session {session_id} did not become ready").into());
        }
        sleep(WORKER_READY_POLL).await;
    }
}

#[derive(Debug, Clone)]
struct SessionInfo {
    session_id: u32,
    username: String,
}

fn enumerate_windows_sessions() -> Result<Vec<SessionInfo>, Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(windows)]
    {
        use windows::Win32::System::RemoteDesktop::{
            WTS_CURRENT_SERVER_HANDLE, WTSFreeMemory, WTSQuerySessionInformationW,
            WTSUserName, WTS_SESSION_INFOW, WTSEnumerateSessionsW,
        };
        use windows::core::PWSTR;

        unsafe {
            let mut sessions_ptr: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
            let mut count = 0u32;
            WTSEnumerateSessionsW(
                Some(WTS_CURRENT_SERVER_HANDLE),
                0,
                1,
                &mut sessions_ptr,
                &mut count,
            )?;

            if sessions_ptr.is_null() {
                return Ok(Vec::new());
            }

            let sessions = std::slice::from_raw_parts(sessions_ptr, count as usize);
            let mut result = Vec::new();

            for session in sessions {
                if session.SessionId == 0 {
                    continue;
                }

                let mut username_ptr = PWSTR(std::ptr::null_mut());
                let mut bytes = 0u32;
                let username_result = WTSQuerySessionInformationW(
                    Some(WTS_CURRENT_SERVER_HANDLE),
                    session.SessionId,
                    WTSUserName,
                    &mut username_ptr,
                    &mut bytes,
                );

                if username_result.is_err() || username_ptr.is_null() {
                    continue;
                }

                let chars = std::slice::from_raw_parts(
                    username_ptr.as_ptr(),
                    (bytes as usize / 2).saturating_sub(1),
                );
                let username = String::from_utf16_lossy(chars);
                WTSFreeMemory(username_ptr.as_ptr() as _);

                if username.trim().is_empty() || username.eq_ignore_ascii_case("system") {
                    continue;
                }

                info!(
                    session_id = session.SessionId,
                    username = %username,
                    "discovered interactive Windows session"
                );
                result.push(SessionInfo {
                    session_id: session.SessionId,
                    username,
                });
            }

            WTSFreeMemory(sessions_ptr as _);
            Ok(result)
        }
    }

    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

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
