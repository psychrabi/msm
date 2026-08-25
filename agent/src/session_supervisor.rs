use std::{collections::HashSet, sync::Arc, time::Duration};

use tokio::{net::TcpStream, sync::Mutex, time::sleep};
use tracing::{info, warn};

use crate::{
    allocate_worker_port, discover_windows_sessions, spawn_worker, terminate_worker, AppState,
    RemoteSession, FIRST_VNC_PORT,
};

const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(2);
const WORKER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const WORKER_READY_POLL: Duration = Duration::from_millis(100);

pub async fn run(state: AppState) {
    reconcile(&state).await;

    loop {
        sleep(SUPERVISOR_INTERVAL).await;
        reconcile(&state).await;
    }
}

pub async fn ensure_session(state: &AppState, session_id: u32) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(existing) = state.workers.lock().await.get(&session_id).cloned() {
        if TcpStream::connect(("127.0.0.1", existing.port)).await.is_ok() {
            return Ok(existing);
        }

        warn!(session_id, port = existing.port, "VNC worker stopped responding; restarting");
        terminate_worker(existing.worker_pid);
        state.workers.lock().await.remove(&session_id);
    }

    let port = allocate_worker_port(&state.workers.lock().await, FIRST_VNC_PORT)
        .ok_or_else(|| "no available VNC worker ports".to_string())?;
    let password = state.auth_token.chars().take(8).collect::<String>();
    let worker_pid = spawn_worker(session_id, port, &password)?;

    let deadline = tokio::time::Instant::now() + WORKER_READY_TIMEOUT;
    loop {
        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            let session = RemoteSession {
                session_id: session_id.to_string(),
                port,
                vnc_password: password,
                worker_pid,
            };
            state.workers.lock().await.insert(session_id, session.clone());
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

async fn reconcile(state: &AppState) {
    let active_sessions = discover_windows_sessions().await;
    let active_ids: HashSet<u32> = active_sessions
        .iter()
        .filter_map(|session| session.session_id.parse().ok())
        .collect();

    for session_id in &active_ids {
        if let Err(error) = ensure_session(state, *session_id).await {
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
            info!(session_id, worker_pid, "removed worker for inactive session");
        }
    }
}
