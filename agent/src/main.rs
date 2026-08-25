use std::{
    collections::HashMap,
    env,
    fs,
    io,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
};

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Path, Query, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{any, get},
    Json, Router,
};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    signal,
    sync::{Mutex, oneshot},
    time::{sleep, Duration},
};
use tracing::{info, warn};

mod session_supervisor;

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_LISTEN: &str = "127.0.0.1:40123";
const FIRST_VNC_PORT: u16 = 5901;
const MAX_VNC_PORT: u16 = 5999;

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
struct SessionInfo {
    session_id: String,
    username: String,
    state: String,
    seat_id: Option<String>,
    display: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSession {
    session_id: String,
    port: u16,
    vnc_password: String,
    #[serde(skip)]
    worker_pid: u32,
}

#[derive(Clone)]
struct AppState {
    identity: DeviceIdentity,
    auth_token: String,
    workers: Arc<Mutex<HashMap<u32, RemoteSession>>>,
    worker_operations: Arc<Mutex<()>>,
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
    },
    Ping,
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: String,
}

fn identity_path() -> Result<PathBuf, io::Error> {
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unable to determine local data directory"))?;
    Ok(base.join("MSM").join("agent").join("identity.json"))
}

fn token_path() -> Result<PathBuf, io::Error> {
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unable to determine local data directory"))?;
    Ok(base.join("MSM").join("agent").join("access-token"))
}

fn load_or_create_identity() -> Result<DeviceIdentity, Box<dyn std::error::Error + Send + Sync>> {
    let path = identity_path()?;
    if let Ok(contents) = fs::read_to_string(&path) {
        return Ok(serde_json::from_str(&contents)?);
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
    let path = token_path()?;
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
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == expected)
}

async fn health(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&headers, &state.auth_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "status": "ok", "device": state.identity })),
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
        let Message::Text(text) = message else { continue };
        let response = match serde_json::from_str::<ClientMessage>(&text) {
            Ok(ClientMessage::ListSessions) => ServerMessage::Sessions {
                sessions: discover_windows_sessions().await,
            },
            Ok(ClientMessage::StartSession { session_id }) => {
                match start_session(&state, &session_id).await {
                    Ok(session) => ServerMessage::RemoteSession { session },
                    Err(error) => ServerMessage::Error {
                        message: error.to_string(),
                    },
                }
            }
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
    Path(session_id): Path<u32>,
    Query(query): Query<TokenQuery>,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if query.token != state.auth_token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let session = state.workers.lock().await.get(&session_id).cloned();
    let Some(session) = session else {
        return StatusCode::NOT_FOUND.into_response();
    };

    ws.on_upgrade(move |socket| proxy_vnc(socket, session.port))
}

async fn proxy_vnc(websocket: WebSocket, port: u16) {
    let Ok(tcp) = TcpStream::connect(("127.0.0.1", port)).await else {
        return;
    };

    let (mut read_half, mut write_half) = tcp.into_split();
    let (mut ws_tx, mut ws_rx) = websocket.split();

    let to_tcp = async {
        while let Some(Ok(message)) = ws_rx.next().await {
            match message {
                Message::Binary(bytes) => {
                    if write_half.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    let to_ws = async {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let count = match read_half.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            if ws_tx
                .send(Message::Binary(buffer[..count].to_vec().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    };

    tokio::select! {
        _ = to_tcp => {},
        _ = to_ws => {},
    }
}

async fn discover_windows_sessions() -> Vec<SessionInfo> {
    tokio::task::spawn_blocking(|| windows_sessions().unwrap_or_default())
        .await
        .unwrap_or_default()
}

#[cfg(windows)]
fn windows_sessions() -> Result<Vec<SessionInfo>, Box<dyn std::error::Error + Send + Sync>> {
    use windows::Win32::System::RemoteDesktop::{
        WTS_CURRENT_SERVER_HANDLE, WTS_SESSION_INFOW, WTSActive, WTSFreeMemory,
        WTSEnumerateSessionsW,
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

        let sessions = std::slice::from_raw_parts(sessions_ptr, count as usize);
        let mut result = Vec::new();

        for session in sessions {
            if session.State != WTSActive {
                continue;
            }

            let id = session.SessionId;
            let username = query_username(id).unwrap_or_else(|| "unknown".to_owned());
            result.push(SessionInfo {
                session_id: id.to_string(),
                username,
                state: "active".to_owned(),
                seat_id: Some(format!("seat-{id}")),
                display: None,
            });
        }

        WTSFreeMemory(sessions_ptr as _);
        Ok(result)
    }
}

#[cfg(windows)]
fn query_username(session_id: u32) -> Option<String> {
    use windows::{
        core::PWSTR,
        Win32::System::RemoteDesktop::{
            WTS_CURRENT_SERVER_HANDLE, WTSFreeMemory, WTSQuerySessionInformationW, WTSUserName,
        },
    };

    unsafe {
        let mut buffer = PWSTR(std::ptr::null_mut());
        let mut bytes = 0u32;
        WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            session_id,
            WTSUserName,
            &mut buffer,
            &mut bytes,
        )
        .ok()?;

        let chars = std::slice::from_raw_parts(
            buffer.as_ptr(),
            (bytes as usize / 2).saturating_sub(1),
        );
        let name = String::from_utf16_lossy(chars);
        WTSFreeMemory(buffer.as_ptr() as _);
        Some(name)
    }
}

#[cfg(not(windows))]
fn windows_sessions() -> Result<Vec<SessionInfo>, Box<dyn std::error::Error + Send + Sync>> {
    Ok(Vec::new())
}

async fn start_session(
    state: &AppState,
    session_id: &str,
) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    let id: u32 = session_id.parse()?;
    session_supervisor::ensure_session(state, id).await
}

fn allocate_worker_port(
    workers: &HashMap<u32, RemoteSession>,
    first_port: u16,
) -> Option<u16> {
    (first_port..=MAX_VNC_PORT).find(|port| workers.values().all(|worker| worker.port != *port))
}

#[cfg(windows)]
fn spawn_worker(
    session_id: u32,
    port: u16,
    password: &str,
) -> Result<u32, Box<dyn std::error::Error + Send + Sync>> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows::{
        core::PWSTR,
        Win32::Foundation::CloseHandle,
        Win32::System::RemoteDesktop::WTSQueryUserToken,
        Win32::System::Threading::{
            CreateProcessAsUserW, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTUPINFOW,
        },
    };

    unsafe {
        let mut token = Default::default();
        WTSQueryUserToken(session_id, &mut token).map_err(|e| {
            format!("WTSQueryUserToken(session {session_id}) failed: {e}")
        })?;

        let exe = env::current_exe()?.with_file_name("msm-agent-worker.exe");
        let command = format!(
            "\"{}\" --session-id {} --port {} --password {}",
            exe.display(), session_id, port, password
        );
        let mut command_w: Vec<u16> = OsStr::new(&command)
            .encode_wide()
            .chain(Some(0))
            .collect();
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
        .map_err(|e| format!("CreateProcessAsUserW(session {session_id}) failed: {e}"))?;

        let pid = process.dwProcessId;
        CloseHandle(process.hThread)?;
        CloseHandle(process.hProcess)?;
        CloseHandle(token)?;
        Ok(pid)
    }
}

#[cfg(not(windows))]
fn spawn_worker(
    _session_id: u32,
    _port: u16,
    _password: &str,
) -> Result<u32, Box<dyn std::error::Error + Send + Sync>> {
    Err("Windows only".into())
}

#[cfg(windows)]
fn terminate_worker(pid: u32) {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE},
    };

    unsafe {
        match OpenProcess(PROCESS_TERMINATE, false, pid) {
            Ok(process) => {
                if let Err(error) = TerminateProcess(process, 1) {
                    warn!(pid, %error, "failed to terminate VNC worker");
                }
                let _ = CloseHandle(process);
            }
            Err(error) => {
                warn!(pid, %error, "failed to open VNC worker for termination");
            }
        }
    }
}

#[cfg(not(windows))]
fn terminate_worker(_pid: u32) {}

async fn build_app() -> Result<(Router, DeviceIdentity), Box<dyn std::error::Error + Send + Sync>> {
    let identity = load_or_create_identity()?;
    let auth_token = load_or_create_token()?;
    let state = AppState {
        identity: identity.clone(),
        auth_token,
        workers: Arc::new(Mutex::new(HashMap::new())),
        worker_operations: Arc::new(Mutex::new(())),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", any(websocket))
        .route("/vnc/{session_id}", any(vnc_websocket))
        .with_state(state);

    Ok((app, identity))
}

async fn run_server(
    listen: SocketAddr,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    ready: Option<oneshot::Sender<Result<(), String>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (app, identity) = build_app().await?;
    let state = app
        .state::<AppState>()
        .expect("MSM router state must be AppState")
        .clone();

    let listener = match tokio::net::TcpListener::bind(listen).await {
        Ok(listener) => listener,
        Err(error) => {
            if let Some(tx) = ready {
                let _ = tx.send(Err(error.to_string()));
            }
            return Err(error.into());
        }
    };

    if let Some(tx) = ready {
        let _ = tx.send(Ok(()));
    }

    info!(
        device_id = %identity.device_id,
        device_name = %identity.device_name,
        listen = %listen,
        "MSM Windows agent started"
    );

    tokio::spawn(session_supervisor::run(state));
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

#[cfg(windows)]
const SERVICE_NAME: &str = "MSMAgent";
#[cfg(windows)]
const SERVICE_DISPLAY_NAME: &str = "MSM Agent";
#[cfg(windows)]
const SERVICE_DESCRIPTION: &str = "MSM multiseat remote monitor and control agent";
#[cfg(windows)]
const SERVICE_LISTEN: &str = "0.0.0.0:40123";

#[cfg(windows)]
fn install_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::{ffi::OsString, path::PathBuf};
    use windows_service::{
        service::{ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceType},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };

    let service_manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )?;
    let executable_path = env::current_exe()?;
    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: PathBuf::from(&executable_path),
        launch_arguments: vec![OsString::from("--run-service")],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };

    let service_access = ServiceAccess::QUERY_STATUS
        | ServiceAccess::QUERY_CONFIG
        | ServiceAccess::CHANGE_CONFIG
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::DELETE;

    if let Ok(existing) = service_manager.open_service(SERVICE_NAME, service_access) {
        let _ = existing.stop();
        let _ = existing.delete();
        drop(existing);
        std::thread::sleep(Duration::from_millis(500));
    }

    let service = service_manager.create_service(&service_info, service_access)?;
    service.set_description(SERVICE_DESCRIPTION)?;
    println!("MSM Agent service installed.");
    println!("Executable: {}", executable_path.display());
    println!("Service arguments: --run-service");
    Ok(())
}

#[cfg(windows)]
fn uninstall_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use windows_service::{
        service::{ServiceAccess, ServiceState},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };

    let service_manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service_access = ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE;
    let service = match service_manager.open_service(SERVICE_NAME, service_access) {
        Ok(service) => service,
        Err(error) => {
            println!("MSM Agent service is not installed: {error}");
            return Ok(());
        }
    };

    if service.query_status()?.current_state != ServiceState::Stopped {
        let _ = service.stop();
    }
    service.delete()?;
    println!("MSM Agent service uninstalled.");
    Ok(())
}

#[cfg(windows)]
fn start_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use windows_service::{
        service::ServiceAccess,
        service_manager::{ServiceManager, ServiceManagerAccess},
    };

    let service_manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service = service_manager.open_service(SERVICE_NAME, ServiceAccess::START | ServiceAccess::QUERY_STATUS)?;
    service.start::<&str>(&[])?;
    println!("MSM Agent service start requested.");
    Ok(())
}

#[cfg(windows)]
fn stop_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use windows_service::{
        service::ServiceAccess,
        service_manager::{ServiceManager, ServiceManagerAccess},
    };

    let service_manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service = service_manager.open_service(SERVICE_NAME, ServiceAccess::STOP | ServiceAccess::QUERY_STATUS)?;
    let _ = service.stop()?;
    println!("MSM Agent service stop requested.");
    Ok(())
}

#[cfg(windows)]
fn run_as_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::ffi::OsString;
    use std::sync::mpsc;
    use windows_service::{
        define_windows_service,
        service::{ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType},
        service_control_handler::{self, ServiceControlHandlerResult},
        service_dispatcher,
    };

    define_windows_service!(ffi_service_main, service_main);

    fn service_main(_arguments: Vec<OsString>) {
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
            Err(error) => {
                eprintln!("failed to register MSM service control handler: {error}");
                return;
            }
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
            Err(error) => {
                eprintln!("failed to create Tokio runtime for MSM service: {error}");
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
        };

        let (result_tx, result_rx) = oneshot::channel::<Result<(), String>>();
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
            Some(result_tx),
        ));

        match result_rx.blocking_recv() {
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
            Ok(Err(error)) => {
                eprintln!("MSM service failed to start: {error}");
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
            Err(error) => {
                eprintln!("MSM service startup channel failed: {error}");
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

#[cfg(windows)]
fn run_service_entrypoint() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    run_as_windows_service()
}

fn run_normal(args: Args) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(run_server(
        args.listen,
        async {
            let _ = signal::ctrl_c().await;
            warn!("shutdown requested");
        },
        None,
    ))
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();

    if args.print_identity {
        let identity = load_or_create_identity()?;
        let auth_token = load_or_create_token()?;
        println!("{}", serde_json::to_string_pretty(&identity)?);
        println!("access_token={auth_token}");
        return Ok(());
    }

    #[cfg(windows)]
    {
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
            return run_service_entrypoint();
        }
    }

    #[cfg(not(windows))]
    if args.install_service
        || args.uninstall_service
        || args.start_service
        || args.stop_service
        || args.run_service
    {
        return Err("Windows service management is only supported on Windows".into());
    }

    run_normal(args)
}
