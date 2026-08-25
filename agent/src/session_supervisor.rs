use std::{collections::HashSet, net::TcpStream, thread, time::Duration};

use tracing::{info, warn};

use crate::{
    spawn_worker, terminate_worker, AppState, RemoteSession, FIRST_VNC_PORT, MAX_VNC_PORT,
};

const WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);
const WORKER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const WORKER_READY_POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: u32,
    pub username: String,
}

/// The MSM Windows service owns this thread for the lifetime of the service.
///
/// This deliberately follows the reference VNC/ASTER architecture: there is
/// one system service, one worker registry, and one simple reconciliation loop.
/// Workers never supervise themselves.
pub fn start(state: AppState) {
    thread::Builder::new()
        .name("msm-worker-watchdog".to_owned())
        .spawn(move || run_watchdog(state))
        .expect("failed to start MSM worker watchdog");
}

fn run_watchdog(state: AppState) {
    info!("MSM worker watchdog started");

    loop {
        reconcile(&state);
        thread::sleep(WATCHDOG_INTERVAL);
    }
}

fn reconcile(state: &AppState) {
    let sessions = match enumerate_windows_sessions() {
        Ok(sessions) => sessions,
        Err(error) => {
            warn!(%error, "failed to enumerate Windows sessions; preserving workers");
            return;
        }
    };

    let active_sessions: HashSet<u32> =
        sessions.iter().map(|session| session.session_id).collect();

    // First remove workers whose processes have actually exited. This is the
    // worker-crash/kill recovery path.
    {
        let mut workers = state.workers.blocking_lock();
        workers.retain(|session_id, worker| {
            if is_process_alive(worker.worker_pid) {
                true
            } else {
                warn!(
                    session_id,
                    worker_pid = worker.worker_pid,
                    "worker exited; it will be respawned"
                );
                false
            }
        });
    }

    // Then clean up workers belonging to sessions that really disappeared.
    // This only runs after successful session enumeration.
    {
        let mut workers = state.workers.blocking_lock();
        let stale: Vec<(u32, u32)> = workers
            .iter()
            .filter_map(|(session_id, worker)| {
                (!active_sessions.contains(session_id)).then_some((*session_id, worker.worker_pid))
            })
            .collect();

        for (session_id, worker_pid) in stale {
            info!(
                session_id,
                worker_pid,
                "interactive session ended; stopping worker"
            );
            terminate_worker(worker_pid);
            workers.remove(&session_id);
        }
    }

    // Finally make sure every active session has exactly one worker.
    for session in sessions {
        let worker_alive = {
            let workers = state.workers.blocking_lock();
            workers
                .get(&session.session_id)
                .is_some_and(|worker| is_process_alive(worker.worker_pid))
        };

        if !worker_alive {
            if let Err(error) = spawn_worker_for_session(state, &session) {
                warn!(
                    session_id = session.session_id,
                    username = %session.username,
                    %error,
                    "failed to start worker; watchdog will retry"
                );
            }
        }
    }
}

fn spawn_worker_for_session(
    state: &AppState,
    session: &SessionInfo,
) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    let _lifecycle_lock = state.worker_operations.blocking_lock();

    // Re-check after acquiring the lifecycle lock. A viewer request and the
    // watchdog must never create two workers for the same session.
    if let Some(existing) = state.workers.blocking_lock().get(&session.session_id).cloned() {
        if is_process_alive(existing.worker_pid) {
            return Ok(existing);
        }
        terminate_worker(existing.worker_pid);
        state.workers.blocking_lock().remove(&session.session_id);
    }

    let port = {
        let workers = state.workers.blocking_lock();
        allocate_worker_port(&workers)
    }
    .ok_or_else(|| "no available VNC worker ports".to_owned())?;

    let password = state.auth_token.chars().take(8).collect::<String>();
    let worker_pid = spawn_worker(session.session_id, port, &password)?;

    info!(
        session_id = session.session_id,
        username = %session.username,
        worker_pid,
        port,
        "spawned session worker"
    );

    if !wait_for_worker_ready(worker_pid, port) {
        terminate_worker(worker_pid);
        return Err(format!(
            "worker PID {worker_pid} did not become ready on port {port}"
        )
        .into());
    }

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

    Ok(remote_session)
}

fn wait_for_worker_ready(pid: u32, port: u16) -> bool {
    let deadline = std::time::Instant::now() + WORKER_READY_TIMEOUT;
    let address = match format!("127.0.0.1:{port}").parse() {
        Ok(address) => address,
        Err(_) => return false,
    };

    while std::time::Instant::now() < deadline {
        if !is_process_alive(pid) {
            return false;
        }

        if TcpStream::connect_timeout(&address, WORKER_READY_POLL).is_ok() {
            return true;
        }

        thread::sleep(WORKER_READY_POLL);
    }

    false
}

fn allocate_worker_port(
    workers: &std::collections::HashMap<u32, RemoteSession>,
) -> Option<u16> {
    (FIRST_VNC_PORT..=MAX_VNC_PORT).find(|port| workers.values().all(|worker| worker.port != *port))
}

pub async fn ensure_session(
    state: &AppState,
    session_id: u32,
) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        let session = enumerate_windows_sessions()?
            .into_iter()
            .find(|session| session.session_id == session_id)
            .ok_or_else(|| format!("session {session_id} is not active"))?;
        spawn_worker_for_session(&state, &session)
    })
    .await
    .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)?
}

fn enumerate_windows_sessions() -> Result<Vec<SessionInfo>, Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(windows)]
    {
        use windows::core::PWSTR;
        use windows::Win32::System::RemoteDesktop::{
            WTS_CURRENT_SERVER_HANDLE, WTSFreeMemory, WTSQuerySessionInformationW, WTSUserName,
            WTS_SESSION_INFOW, WTSEnumerateSessionsW,
        };

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
                // Match the reference implementation: ignore Session 0 and
                // accept any non-system interactive session with a username.
                if session.SessionId == 0 {
                    continue;
                }

                let mut username_ptr = PWSTR(std::ptr::null_mut());
                let mut bytes = 0u32;
                if WTSQuerySessionInformationW(
                    Some(WTS_CURRENT_SERVER_HANDLE),
                    session.SessionId,
                    WTSUserName,
                    &mut username_ptr,
                    &mut bytes,
                )
                .is_err()
                    || username_ptr.is_null()
                {
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
                    "discovered interactive session"
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
            let process = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(process) => process,
                Err(_) => return false,
            };

            let mut exit_code = 0u32;
            let alive = GetExitCodeProcess(process, &mut exit_code).is_ok()
                && exit_code == STILL_ACTIVE;
            let _ = CloseHandle(process);
            alive
        }
    }

    #[cfg(not(windows))]
    {
        let _ = pid;
        true
    }
}
