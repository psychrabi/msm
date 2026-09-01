use crate::{
    AppState, FIRST_VNC_PORT, MAX_VNC_PORT, RemoteSession, WorkerKey, spawn_worker,
    terminate_worker,
};
use std::{
    collections::HashSet,
    net::TcpStream,
    thread,
    time::{Duration, Instant},
};
use tracing::{info, warn};

const WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);
const WORKER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const WORKER_READY_POLL: Duration = Duration::from_millis(100);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: u32,
    pub username: String,
}

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
fn retry_delay(failure_count: u32) -> Duration {
    Duration::from_secs((3u64).saturating_mul(1u64 << failure_count.saturating_sub(1).min(5)))
        .min(MAX_RETRY_DELAY)
}
fn retry_allowed(state: &AppState, session_id: u32) -> bool {
    let failures = state.worker_failures.blocking_lock();
    let Some((count, at)) = failures.get(&session_id) else {
        return true;
    };
    at.elapsed() >= retry_delay(*count)
}
fn record_failure(state: &AppState, session_id: u32) {
    let mut failures = state.worker_failures.blocking_lock();
    let entry = failures.entry(session_id).or_insert((0, Instant::now()));
    entry.0 = entry.0.saturating_add(1);
    entry.1 = Instant::now();
    warn!(
        session_id,
        attempt = entry.0,
        "worker start failure recorded; retry backoff active"
    );
}
fn clear_failure(state: &AppState, session_id: u32) {
    state.worker_failures.blocking_lock().remove(&session_id);
}

fn reconcile(state: &AppState) {
    let sessions = match enumerate_windows_sessions() {
        Ok(s) => s,
        Err(e) => {
            warn!(%e,"failed to enumerate Windows sessions; preserving workers");
            return;
        }
    };
    let active_sessions: HashSet<u32> = sessions.iter().map(|s| s.session_id).collect();
    {
        let mut workers = state.workers.blocking_lock();
        workers.retain(|key, worker| {
            if is_process_alive(worker.worker_pid) {
                true
            } else {
                warn!(
                    session_id = key.session_id,
                    monitor_index = key.monitor_index,
                    worker_pid = worker.worker_pid,
                    "worker exited"
                );
                false
            }
        });
    }
    {
        let mut workers = state.workers.blocking_lock();
        let stale: Vec<(WorkerKey, u32)> = workers
            .iter()
            .filter_map(|(key, w)| {
                (!active_sessions.contains(&key.session_id)).then_some((*key, w.worker_pid))
            })
            .collect();
        for (key, pid) in stale {
            info!(
                session_id = key.session_id,
                monitor_index = key.monitor_index,
                worker_pid = pid,
                "interactive session ended; stopping worker"
            );
            terminate_worker(pid);
            workers.remove(&key);
            clear_failure(state, key.session_id);
        }
    }
    // Keep one primary-display worker warm for every active session. Secondary
    // monitor workers are demand-driven by the Viewer and stay alive until the
    // session ends, so multiple monitors can be viewed simultaneously.
    for session in sessions {
        let key = WorkerKey {
            session_id: session.session_id,
            monitor_index: 0,
        };
        let alive = state
            .workers
            .blocking_lock()
            .get(&key)
            .is_some_and(|w| is_process_alive(w.worker_pid));
        if alive {
            clear_failure(state, session.session_id);
            continue;
        }
        if !retry_allowed(state, session.session_id) {
            continue;
        }
        match spawn_worker_for_monitor(state, &session, 0, true) {
            Ok(_) => clear_failure(state, session.session_id),
            Err(e) => {
                record_failure(state, session.session_id);
                warn!(session_id=session.session_id,username=%session.username,%e,"failed to start primary worker; watchdog will retry");
            }
        }
    }
}

fn spawn_worker_for_monitor(
    state: &AppState,
    session: &SessionInfo,
    monitor_index: u32,
    legacy_primary: bool,
) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    let _lifecycle_lock = state.worker_operations.blocking_lock();
    let key = WorkerKey {
        session_id: session.session_id,
        monitor_index,
    };
    if let Some(existing) = state.workers.blocking_lock().get(&key).cloned() {
        if is_process_alive(existing.worker_pid) {
            return Ok(existing);
        }
        terminate_worker(existing.worker_pid);
        state.workers.blocking_lock().remove(&key);
    }
    let port = ({
        let workers = state.workers.blocking_lock();
        allocate_worker_port(&workers)
    })
    .ok_or_else(|| "no available VNC worker ports".to_owned())?;
    let password = uuid::Uuid::new_v4().simple().to_string();
    let worker_pid = spawn_worker(
        session.session_id,
        port,
        &password,
        if legacy_primary {
            None
        } else {
            Some(monitor_index)
        },
    )?;
    info!(session_id=session.session_id,username=%session.username,monitor_index,worker_pid,port,"spawned session monitor worker");
    if !wait_for_worker_ready(worker_pid, port) {
        terminate_worker(worker_pid);
        return Err(format!("worker PID {worker_pid} did not become ready on port {port}").into());
    }
    let remote = RemoteSession {
        session_id: session.session_id.to_string(),
        monitor_index,
        port,
        vnc_password: password,
        vnc_ticket: String::new(),
        worker_pid,
    };
    state.workers.blocking_lock().insert(key, remote.clone());
    Ok(remote)
}

fn wait_for_worker_ready(pid: u32, port: u16) -> bool {
    let deadline = Instant::now() + WORKER_READY_TIMEOUT;
    let address = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    while Instant::now() < deadline {
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
    workers: &std::collections::HashMap<WorkerKey, RemoteSession>,
) -> Option<u16> {
    (FIRST_VNC_PORT..=MAX_VNC_PORT).find(|port| workers.values().all(|worker| worker.port != *port))
}

pub async fn ensure_session_monitor(
    state: &AppState,
    session_id: u32,
    monitor_index: u32,
) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        let session = enumerate_windows_sessions()?
            .into_iter()
            .find(|s| s.session_id == session_id)
            .ok_or_else(|| format!("session {session_id} is not active"))?;
        spawn_worker_for_monitor(&state, &session, monitor_index, false)
    })
    .await
    .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?
}

fn enumerate_windows_sessions() -> Result<Vec<SessionInfo>, Box<dyn std::error::Error + Send + Sync>>
{
    #[cfg(windows)]
    {
        use windows::Win32::System::RemoteDesktop::{
            WTS_CURRENT_SERVER_HANDLE, WTS_SESSION_INFOW, WTSEnumerateSessionsW, WTSFreeMemory,
            WTSQuerySessionInformationW, WTSUserName,
        };
        use windows::core::PWSTR;
        unsafe {
            let mut p: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
            let mut count = 0u32;
            WTSEnumerateSessionsW(Some(WTS_CURRENT_SERVER_HANDLE), 0, 1, &mut p, &mut count)?;
            if p.is_null() {
                return Ok(Vec::new());
            }
            let sessions = std::slice::from_raw_parts(p, count as usize);
            let mut result = Vec::new();
            for session in sessions {
                if session.SessionId == 0 {
                    continue;
                }
                let mut up = PWSTR(std::ptr::null_mut());
                let mut bytes = 0u32;
                if WTSQuerySessionInformationW(
                    Some(WTS_CURRENT_SERVER_HANDLE),
                    session.SessionId,
                    WTSUserName,
                    &mut up,
                    &mut bytes,
                )
                .is_err()
                    || up.is_null()
                {
                    continue;
                }
                let chars = std::slice::from_raw_parts(
                    up.as_ptr(),
                    ((bytes as usize) / 2).saturating_sub(1),
                );
                let username = String::from_utf16_lossy(chars);
                WTSFreeMemory(up.as_ptr() as _);
                if username.trim().is_empty() || username.eq_ignore_ascii_case("system") {
                    continue;
                }
                result.push(SessionInfo {
                    session_id: session.SessionId,
                    username,
                });
            }
            WTSFreeMemory(p as _);
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
                Ok(p) => p,
                Err(_) => return false,
            };
            let mut exit_code = 0u32;
            let alive =
                GetExitCodeProcess(process, &mut exit_code).is_ok() && exit_code == STILL_ACTIVE;
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

#[cfg(test)]
mod tests {
    use super::*;
    fn worker(port: u16, session_id: u32, monitor_index: u32) -> RemoteSession {
        RemoteSession {
            session_id: session_id.to_string(),
            monitor_index,
            port,
            vnc_password: "test".into(),
            vnc_ticket: String::new(),
            worker_pid: 1,
        }
    }
    #[test]
    fn retry_is_bounded() {
        assert_eq!(retry_delay(1), Duration::from_secs(3));
        assert_eq!(retry_delay(6), MAX_RETRY_DELAY)
    }
    #[test]
    fn allocates_ports_across_monitors() {
        let mut workers = std::collections::HashMap::new();
        workers.insert(
            WorkerKey {
                session_id: 1,
                monitor_index: 0,
            },
            worker(FIRST_VNC_PORT, 1, 0),
        );
        workers.insert(
            WorkerKey {
                session_id: 1,
                monitor_index: 1,
            },
            worker(FIRST_VNC_PORT + 1, 1, 1),
        );
        assert_eq!(allocate_worker_port(&workers), Some(FIRST_VNC_PORT + 2));
    }
}
