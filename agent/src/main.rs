#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

pub const FIRST_VNC_PORT: u16 = 5901;
pub const MAX_VNC_PORT: u16 = 5999;

use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    response::IntoResponse,
    routing::{any, get},
};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration as StdDuration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    signal,
    sync::{Mutex, oneshot},
    time::Duration,
};
use tracing::{info, warn};

mod session_supervisor;

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_LISTEN: &str = "127.0.0.1:40123";
const VNC_TICKET_TTL: StdDuration = StdDuration::from_secs(300);

#[cfg(windows)]
const SERVICE_NAME: &str = "MSMAgent";
#[cfg(windows)]
const SERVICE_DISPLAY_NAME: &str = "MSM Agent";
#[cfg(windows)]
const SERVICE_DESCRIPTION: &str = "MSM multiseat remote monitor and control agent";
#[cfg(windows)]
const SERVICE_LISTEN: &str = "0.0.0.0:40123";

#[derive(Debug, Parser, Clone)]
#[command(name = "msm-agent", version, about = "MSM Windows machine agent")]
struct Args {
    #[arg(long, default_value = DEFAULT_LISTEN)]
    listen: SocketAddr,
    #[arg(long)]
    print_identity: bool,
    #[arg(long, hide = true)]
    run_service: bool,
    #[arg(long, hide = true)]
    install_service: bool,
    #[arg(long, hide = true)]
    uninstall_service: bool,
    #[arg(long, hide = true)]
    start_service: bool,
    #[arg(long, hide = true)]
    stop_service: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity {
    device_id: uuid::Uuid,
    device_name: String,
    platform: String,
    architecture: String,
    agent_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonitorInfo {
    index: u32,
    name: String,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    session_id: String,
    username: String,
    state: String,
    seat_id: Option<String>,
    display: Option<String>,
    #[serde(default)]
    monitors: Vec<MonitorInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSession {
    session_id: String,
    monitor_index: u32,
    port: u16,
    vnc_password: String,
    vnc_ticket: String,
    #[serde(skip)]
    worker_pid: u32,
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
struct WorkerKey {
    session_id: u32,
    monitor_index: u32,
}

#[derive(Clone)]
struct AppState {
    identity: DeviceIdentity,
    auth_token: String,
    workers: Arc<Mutex<HashMap<WorkerKey, RemoteSession>>>,
    worker_operations: Arc<Mutex<()>>,
    worker_failures: Arc<Mutex<HashMap<u32, (u32, Instant)>>>,
    vnc_tickets: Arc<Mutex<HashMap<String, (WorkerKey, Instant)>>>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage {
    Hello { identity: DeviceIdentity },
    Sessions { sessions: Vec<SessionInfo> },
    RemoteSession { session: RemoteSession },
    Error { message: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    ListSessions,
    StartSession {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "monitorIndex", default)]
        monitor_index: u32,
    },
    Ping,
}

#[derive(Debug, Deserialize)]
struct VncTicketQuery {
    ticket: String,
}

#[cfg(windows)]
fn agent_data_dir() -> PathBuf {
    PathBuf::from(r"C:\ProgramData\MSM\agent")
}

#[cfg(not(windows))]
fn agent_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("MSM")
        .join("agent")
}

fn identity_path() -> PathBuf {
    agent_data_dir().join("identity.json")
}

fn token_path() -> PathBuf {
    agent_data_dir().join("access-token")
}

fn monitor_metadata_path(session_id: u32) -> PathBuf {
    agent_data_dir().join(format!("monitors-{session_id}.json"))
}

fn load_or_create_identity() -> Result<DeviceIdentity, Box<dyn std::error::Error + Send + Sync>> {
    let path = identity_path();
    if let Ok(content) = fs::read_to_string(&path) {
        return Ok(serde_json::from_str(&content)?);
    }
    let identity = DeviceIdentity {
        device_id: uuid::Uuid::new_v4(),
        device_name: hostname(),
        platform: env::consts::OS.to_owned(),
        architecture: env::consts::ARCH.to_owned(),
        agent_version: AGENT_VERSION.to_owned(),
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(&identity)?)?;
    Ok(identity)
}

fn load_or_create_token() -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let path = token_path();
    if let Ok(token) = fs::read_to_string(&path) {
        let token = token.trim().to_owned();
        if !token.is_empty() {
            return Ok(token);
        }
    }
    let token = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, &token)?;
    Ok(token)
}

fn hostname() -> String {
    env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_owned())
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected)
}

async fn health(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&headers, &state.auth_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        );
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({"status":"ok","device":state.identity})),
    )
}

async fn websocket(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !authorized(&headers, &state.auth_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let _ = send_message(
        &mut socket,
        ServerMessage::Hello {
            identity: state.identity.clone(),
        },
    )
    .await;

    while let Some(Ok(message)) = socket.recv().await {
        let Message::Text(text) = message else {
            continue;
        };
        let response = match serde_json::from_str::<ClientMessage>(&text) {
            Ok(ClientMessage::ListSessions) => ServerMessage::Sessions {
                sessions: discover_windows_sessions().await,
            },
            Ok(ClientMessage::StartSession {
                session_id,
                monitor_index,
            }) => match start_session(&state, &session_id, monitor_index).await {
                Ok(session) => ServerMessage::RemoteSession { session },
                Err(error) => ServerMessage::Error {
                    message: error.to_string(),
                },
            },
            Ok(ClientMessage::Ping) => ServerMessage::Hello {
                identity: state.identity.clone(),
            },
            Err(error) => ServerMessage::Error {
                message: format!("invalid request: {error}"),
            },
        };
        if send_message(&mut socket, response).await.is_err() {
            break;
        }
    }
}

async fn send_message(socket: &mut WebSocket, message: ServerMessage) -> Result<(), ()> {
    let payload = serde_json::to_string(&message).map_err(|_| ())?;
    socket
        .send(Message::Text(payload.into()))
        .await
        .map_err(|_| ())
}

async fn vnc_websocket(
    Path((session_id, monitor_index)): Path<(u32, u32)>,
    Query(query): Query<VncTicketQuery>,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let key = WorkerKey {
        session_id,
        monitor_index,
    };
    let valid = {
        let mut tickets = state.vnc_tickets.lock().await;
        let now = Instant::now();
        tickets.retain(|_, (_, expiry)| *expiry > now);
        tickets
            .get(&query.ticket)
            .is_some_and(|(ticket_key, expiry)| *ticket_key == key && *expiry > now)
    };
    if !valid {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let session = state.workers.lock().await.get(&key).cloned();
    let Some(session) = session else {
        return StatusCode::NOT_FOUND.into_response();
    };
    ws.on_upgrade(move |socket| proxy_vnc(socket, session.port))
}

async fn proxy_vnc(websocket: WebSocket, port: u16) {
    let Ok(tcp) = TcpStream::connect(("127.0.0.1", port)).await else {
        return;
    };
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (mut ws_write, mut ws_read) = websocket.split();

    let websocket_to_tcp = async {
        while let Some(Ok(message)) = ws_read.next().await {
            match message {
                Message::Binary(bytes) => {
                    if tcp_write.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    let tcp_to_websocket = async {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let count = match tcp_read.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            if ws_write
                .send(Message::Binary(buffer[..count].to_vec().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    };

    tokio::select! {
        _ = websocket_to_tcp => {},
        _ = tcp_to_websocket => {},
    }
}

fn read_monitors(session_id: u32) -> Vec<MonitorInfo> {
    fs::read_to_string(monitor_metadata_path(session_id))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

async fn discover_windows_sessions() -> Vec<SessionInfo> {
    tokio::task::spawn_blocking(|| windows_sessions().unwrap_or_default())
        .await
        .unwrap_or_default()
}

#[cfg(windows)]
fn windows_sessions() -> Result<Vec<SessionInfo>, Box<dyn std::error::Error + Send + Sync>> {
    use windows::Win32::System::RemoteDesktop::{
        WTS_CURRENT_SERVER_HANDLE, WTSEnumerateSessionsW, WTSFreeMemory,
        WTSQuerySessionInformationW, WTSUserName,
    };
    use windows::core::PWSTR;

    unsafe {
        let mut pointer = std::ptr::null_mut();
        let mut count = 0u32;
        WTSEnumerateSessionsW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            0,
            1,
            &mut pointer,
            &mut count,
        )?;
        if pointer.is_null() {
            return Ok(Vec::new());
        }

        let sessions = std::slice::from_raw_parts(pointer, count as usize);
        let mut result = Vec::new();
        for session in sessions {
            if session.SessionId == 0 {
                continue;
            }
            let mut username_pointer = PWSTR(std::ptr::null_mut());
            let mut bytes = 0u32;
            if WTSQuerySessionInformationW(
                Some(WTS_CURRENT_SERVER_HANDLE),
                session.SessionId,
                WTSUserName,
                &mut username_pointer,
                &mut bytes,
            )
            .is_err()
                || username_pointer.is_null()
            {
                continue;
            }
            let chars = std::slice::from_raw_parts(
                username_pointer.as_ptr(),
                ((bytes as usize) / 2).saturating_sub(1),
            );
            let username = String::from_utf16_lossy(chars);
            WTSFreeMemory(username_pointer.as_ptr() as _);
            if username.trim().is_empty() || username.eq_ignore_ascii_case("system") {
                continue;
            }
            result.push(SessionInfo {
                session_id: session.SessionId.to_string(),
                username,
                state: "active".to_owned(),
                seat_id: Some(format!("seat-{}", session.SessionId)),
                display: None,
                monitors: read_monitors(session.SessionId),
            });
        }
        WTSFreeMemory(pointer as _);
        Ok(result)
    }
}

#[cfg(not(windows))]
fn windows_sessions() -> Result<Vec<SessionInfo>, Box<dyn std::error::Error + Send + Sync>> {
    Ok(Vec::new())
}

async fn start_session(
    state: &AppState,
    session_id: &str,
    monitor_index: u32,
) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    let id: u32 = session_id.parse()?;
    let monitors = read_monitors(id);
    if !monitors.is_empty() && !monitors.iter().any(|monitor| monitor.index == monitor_index) {
        return Err(format!("monitor {monitor_index} is unavailable for session {id}").into());
    }
    let mut session =
        session_supervisor::ensure_session_monitor(state, id, monitor_index).await?;
    let ticket = uuid::Uuid::new_v4().to_string();
    let key = WorkerKey {
        session_id: id,
        monitor_index,
    };
    state.vnc_tickets.lock().await.insert(
        ticket.clone(),
        (key, Instant::now() + VNC_TICKET_TTL),
    );
    session.vnc_ticket = ticket;
    Ok(session)
}

#[cfg(windows)]
fn spawn_worker(
    session_id: u32,
    port: u16,
    password: &str,
    monitor_index: Option<u32>,
) -> Result<u32, Box<dyn std::error::Error + Send + Sync>> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows::{
        Win32::Foundation::CloseHandle,
        Win32::System::RemoteDesktop::WTSQueryUserToken,
        Win32::System::Threading::{
            CreateProcessAsUserW, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTUPINFOW,
        },
        core::PWSTR,
    };

    unsafe {
        let mut token = Default::default();
        WTSQueryUserToken(session_id, &mut token)
            .map_err(|error| format!("WTSQueryUserToken(session {session_id}) failed: {error}"))?;
        let exe = env::current_exe()?.with_file_name("msm-agent-worker.exe");
        let monitor_arg = monitor_index
            .map(|index| format!(" --monitor-index {index}"))
            .unwrap_or_default();
        let command = format!(
            "\"{}\" --session-id {} --port {} --password {}{}",
            exe.display(),
            session_id,
            port,
            password,
            monitor_arg,
        );
        let mut command_w: Vec<u16> = OsStr::new(&command).encode_wide().chain(Some(0)).collect();
        let desktop: Vec<u16> = OsStr::new("winsta0\\default")
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut startup = STARTUPINFOW::default();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.lpDesktop = PWSTR(desktop.as_ptr() as *mut u16);
        let mut process = PROCESS_INFORMATION::default();
        CreateProcessAsUserW(
            Some(token),
            None,
            Some(PWSTR(command_w.as_mut_ptr())),
            None,
            None,
            false,
            PROCESS_CREATION_FLAGS(0),
            None,
            None,
            &startup,
            &mut process,
        )
        .map_err(|error| format!("CreateProcessAsUserW(session {session_id}) failed: {error}"))?;
        let pid = process.dwProcessId;
        CloseHandle(process.hThread)?;
        CloseHandle(process.hProcess)?;
        CloseHandle(token)?;
        Ok(pid)
    }
}

#[cfg(not(windows))]
fn spawn_worker(
    _: u32,
    _: u16,
    _: &str,
    _: Option<u32>,
) -> Result<u32, Box<dyn std::error::Error + Send + Sync>> {
    Err("Windows only".into())
}

#[cfg(windows)]
fn terminate_worker(pid: u32) {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess},
    };

    unsafe {
        match OpenProcess(PROCESS_TERMINATE, false, pid) {
            Ok(process) => {
                if let Err(error) = TerminateProcess(process, 1) {
                    warn!(pid, %error, "failed to terminate VNC worker");
                }
                let _ = CloseHandle(process);
            }
            Err(error) => warn!(pid, %error, "failed to open VNC worker for termination"),
        }
    }
}

#[cfg(not(windows))]
fn terminate_worker(_: u32) {}

async fn build_app() -> Result<(Router, DeviceIdentity), Box<dyn std::error::Error + Send + Sync>> {
    let identity = load_or_create_identity()?;
    let auth_token = load_or_create_token()?;
    let state = AppState {
        identity: identity.clone(),
        auth_token,
        workers: Arc::new(Mutex::new(HashMap::new())),
        worker_operations: Arc::new(Mutex::new(())),
        worker_failures: Arc::new(Mutex::new(HashMap::new())),
        vnc_tickets: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", any(websocket))
        .route("/vnc/{session_id}/{monitor_index}", any(vnc_websocket))
        .with_state(state.clone());
    session_supervisor::start(state);
    Ok((app, identity))
}

async fn run_server(
    listen: SocketAddr,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    ready: Option<oneshot::Sender<Result<(), String>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (app, identity) = build_app().await?;
    let listener = match tokio::net::TcpListener::bind(listen).await {
        Ok(listener) => listener,
        Err(error) => {
            if let Some(sender) = ready {
                let _ = sender.send(Err(error.to_string()));
            }
            return Err(error.into());
        }
    };
    if let Some(sender) = ready {
        let _ = sender.send(Ok(()));
    }
    info!(device_id=%identity.device_id,device_name=%identity.device_name,listen=%listen,"MSM Windows agent started without TLS");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

#[cfg(windows)]
fn install_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::{ffi::OsString, path::PathBuf};
    use windows_service::{
        service::{ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceType},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };

    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )?;
    let executable_path = env::current_exe()?;
    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: PathBuf::from(executable_path),
        launch_arguments: vec![OsString::from("--run-service")],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };
    let access = ServiceAccess::QUERY_STATUS
        | ServiceAccess::QUERY_CONFIG
        | ServiceAccess::CHANGE_CONFIG
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::DELETE;
    if let Ok(existing) = manager.open_service(SERVICE_NAME, access) {
        let _ = existing.stop();
        let _ = existing.delete();
        drop(existing);
        std::thread::sleep(Duration::from_millis(500));
    }
    let service = manager.create_service(&info, access)?;
    service.set_description(SERVICE_DESCRIPTION)?;
    Ok(())
}

#[cfg(windows)]
fn uninstall_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use windows_service::{
        service::{ServiceAccess, ServiceState},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service = match manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        Ok(service) => service,
        Err(_) => return Ok(()),
    };
    if service.query_status()?.current_state != ServiceState::Stopped {
        let _ = service.stop();
    }
    service.delete()?;
    Ok(())
}

#[cfg(windows)]
fn start_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use windows_service::{
        service::ServiceAccess,
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    manager
        .open_service(SERVICE_NAME, ServiceAccess::START | ServiceAccess::QUERY_STATUS)?
        .start::<&str>(&[])?;
    Ok(())
}

#[cfg(windows)]
fn stop_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use windows_service::{
        service::ServiceAccess,
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let _ = manager
        .open_service(SERVICE_NAME, ServiceAccess::STOP | ServiceAccess::QUERY_STATUS)?
        .stop()?;
    Ok(())
}

#[cfg(windows)]
fn run_as_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::{ffi::OsString, sync::mpsc};
    use windows_service::{
        define_windows_service,
        service::{
            ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult},
        service_dispatcher,
    };

    define_windows_service!(ffi_service_main, service_main);

    fn service_main(_: Vec<OsString>) {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let status_handle = match service_control_handler::register(SERVICE_NAME, move |event| {
            match event {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    let _ = stop_tx.send(());
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        }) {
            Ok(handle) => handle,
            Err(_) => return,
        };

        let _ = status_handle.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::StartPending,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 1,
            wait_hint: Duration::from_secs(15),
            process_id: None,
        });

        let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(_) => return,
        };
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
        let (stop_tx_async, stop_rx_async) = oneshot::channel::<()>();
        std::thread::spawn(move || {
            let _ = stop_rx.recv();
            let _ = stop_tx_async.send(());
        });
        let server = runtime.spawn(run_server(
            SERVICE_LISTEN.parse().expect("valid service listen address"),
            async move {
                let _ = stop_rx_async.await;
            },
            Some(ready_tx),
        ));

        match ready_rx.blocking_recv() {
            Ok(Ok(())) => {
                let _ = status_handle.set_service_status(ServiceStatus {
                    service_type: ServiceType::OWN_PROCESS,
                    current_state: ServiceState::Running,
                    controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
                    exit_code: ServiceExitCode::Win32(0),
                    checkpoint: 0,
                    wait_hint: Duration::default(),
                    process_id: None,
                });
            }
            _ => {
                let _ = status_handle.set_service_status(ServiceStatus {
                    service_type: ServiceType::OWN_PROCESS,
                    current_state: ServiceState::Stopped,
                    controls_accepted: ServiceControlAccept::empty(),
                    exit_code: ServiceExitCode::Win32(1),
                    checkpoint: 0,
                    wait_hint: Duration::default(),
                    process_id: None,
                });
                return;
            }
        }

        let result = match runtime.block_on(server) {
            Ok(result) => result,
            Err(error) => Err(Box::new(error) as Box<dyn std::error::Error + Send + Sync>),
        };
        let _ = status_handle.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Stopped,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(if result.is_ok() { 0 } else { 1 }),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        });
    }

    service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
    Ok(())
}

#[cfg(not(windows))]
fn install_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    Err("Windows only".into())
}
#[cfg(not(windows))]
fn uninstall_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    Err("Windows only".into())
}
#[cfg(not(windows))]
fn start_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    Err("Windows only".into())
}
#[cfg(not(windows))]
fn stop_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    Err("Windows only".into())
}
#[cfg(not(windows))]
fn run_as_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    Err("Windows only".into())
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = Args::parse();
    if args.print_identity {
        let identity = load_or_create_identity()?;
        let token = load_or_create_token()?;
        println!("{}", serde_json::to_string_pretty(&identity)?);
        println!("access_token={token}");
        return Ok(());
    }
    if args.install_service {
        return install_windows_service();
    }
    if args.uninstall_service {
        return uninstall_windows_service();
    }
    if args.start_service {
        return start_windows_service();
    }
    if args.stop_service {
        return stop_windows_service();
    }
    if args.run_service {
        return run_as_windows_service();
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_server(
        args.listen,
        async {
            let _ = signal::ctrl_c().await;
        },
        None,
    ))
}
