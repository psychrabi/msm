#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

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
#[cfg(not(windows))]
use std::io;
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
mod dpapi;
mod session_supervisor;
const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_LISTEN: &str = "127.0.0.1:40123";
const FIRST_VNC_PORT: u16 = 5901;
const MAX_VNC_PORT: u16 = 5999;
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
    tls_cert: Option<PathBuf>,
    #[arg(long)]
    tls_key: Option<PathBuf>,
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
    vnc_ticket: String,
    #[serde(skip)]
    worker_pid: u32,
}
#[derive(Clone)]
struct AppState {
    identity: DeviceIdentity,
    auth_token: String,
    workers: Arc<Mutex<HashMap<u32, RemoteSession>>>,
    worker_operations: Arc<Mutex<()>>,
    worker_failures: Arc<Mutex<HashMap<u32, (u32, Instant)>>>,
    vnc_tickets: Arc<Mutex<HashMap<String, (u32, Instant)>>>,
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
struct VncTicketQuery {
    ticket: String,
}
#[cfg(windows)]
fn agent_data_dir() -> PathBuf {
    PathBuf::from(r"C:\ProgramData\MSM\agent")
}
#[cfg(not(windows))]
fn agent_data_dir() -> Result<PathBuf, io::Error> {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .map(|b| b.join("MSM").join("agent"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "unable to determine local data directory",
            )
        })
}
fn identity_path() -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(windows)]
    {
        return Ok(agent_data_dir().join("identity.json"));
    }
    #[cfg(not(windows))]
    {
        Ok(agent_data_dir()?.join("identity.json"))
    }
}
fn token_path() -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(windows)]
    {
        return Ok(agent_data_dir().join("access-token"));
    }
    #[cfg(not(windows))]
    {
        Ok(agent_data_dir()?.join("access-token"))
    }
}
fn load_or_create_identity() -> Result<DeviceIdentity, Box<dyn std::error::Error + Send + Sync>> {
    let p = identity_path()?;
    if let Ok(c) = fs::read_to_string(&p) {
        return Ok(serde_json::from_str(&c)?);
    }
    let i = DeviceIdentity {
        device_id: uuid::Uuid::new_v4(),
        device_name: hostname(),
        platform: env::consts::OS.to_owned(),
        architecture: env::consts::ARCH.to_owned(),
        agent_version: AGENT_VERSION.to_owned(),
    };
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(p, serde_json::to_string_pretty(&i)?)?;
    Ok(i)
}
fn load_or_create_token() -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    dpapi::load_or_create_secret(&token_path()?)
}
fn hostname() -> String {
    env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_owned())
}
fn authorized(h: &HeaderMap, t: &str) -> bool {
    let e = format!("Bearer {t}");
    h.get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == e)
}
async fn health(State(s): State<AppState>, h: HeaderMap) -> impl IntoResponse {
    if !authorized(&h, &s.auth_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        );
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({"status":"ok","device":s.identity})),
    )
}
async fn websocket(
    ws: WebSocketUpgrade,
    State(s): State<AppState>,
    h: HeaderMap,
) -> impl IntoResponse {
    if !authorized(&h, &s.auth_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, s))
}
async fn handle_socket(mut socket: WebSocket, s: AppState) {
    let _ = send_message(
        &mut socket,
        ServerMessage::Hello {
            identity: s.identity.clone(),
        },
    )
    .await;
    while let Some(Ok(m)) = socket.recv().await {
        let Message::Text(t) = m else {
            continue;
        };
        let r = match serde_json::from_str::<ClientMessage>(&t) {
            Ok(ClientMessage::ListSessions) => ServerMessage::Sessions {
                sessions: discover_windows_sessions().await,
            },
            Ok(ClientMessage::StartSession { session_id }) => {
                match start_session(&s, &session_id).await {
                    Ok(session) => ServerMessage::RemoteSession { session },
                    Err(e) => ServerMessage::Error {
                        message: e.to_string(),
                    },
                }
            }
            Ok(ClientMessage::Ping) => ServerMessage::Hello {
                identity: s.identity.clone(),
            },
            Err(e) => ServerMessage::Error {
                message: format!("invalid request: {e}"),
            },
        };
        if send_message(&mut socket, r).await.is_err() {
            break;
        }
    }
}
async fn send_message(socket: &mut WebSocket, message: ServerMessage) -> Result<(), ()> {
    let p = serde_json::to_string(&message).map_err(|_| ())?;
    socket.send(Message::Text(p.into())).await.map_err(|_| ())
}
async fn vnc_websocket(
    Path(session_id): Path<u32>,
    Query(q): Query<VncTicketQuery>,
    State(s): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let valid = {
        let mut t = s.vnc_tickets.lock().await;
        let now = Instant::now();
        t.retain(|_, (_, e)| *e > now);
        t.get(&q.ticket)
            .is_some_and(|(id, e)| *id == session_id && *e > now)
    };
    if !valid {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let session = s.workers.lock().await.get(&session_id).cloned();
    let Some(session) = session else {
        return StatusCode::NOT_FOUND.into_response();
    };
    ws.on_upgrade(move |socket| proxy_vnc(socket, session.port))
}
async fn proxy_vnc(websocket: WebSocket, port: u16) {
    let Ok(tcp) = TcpStream::connect(("127.0.0.1", port)).await else {
        return;
    };
    let (mut r, mut w) = tcp.into_split();
    let (mut tx, mut rx) = websocket.split();
    let a = async {
        while let Some(Ok(m)) = rx.next().await {
            match m {
                Message::Binary(b) => {
                    if w.write_all(&b).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => {
                    break;
                }
                _ => {}
            }
        }
    };
    let b = async {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match r.read(&mut buf).await {
                Ok(0) | Err(_) => {
                    break;
                }
                Ok(n) => n,
            };
            if tx
                .send(Message::Binary(buf[..n].to_vec().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    };
    tokio::select! { _=a=>{},_=b=>{} }
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
        let (mut p, mut count) = (std::ptr::null_mut(), 0u32);
        WTSEnumerateSessionsW(Some(WTS_CURRENT_SERVER_HANDLE), 0, 1, &mut p, &mut count)?;
        if p.is_null() {
            return Ok(Vec::new());
        }
        let sessions = std::slice::from_raw_parts(p, count as usize);
        let mut out = Vec::new();
        for session in sessions {
            if session.SessionId == 0 {
                continue;
            }
            let (mut up, mut bytes) = (PWSTR(std::ptr::null_mut()), 0u32);
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
            let chars =
                std::slice::from_raw_parts(up.as_ptr(), ((bytes as usize) / 2).saturating_sub(1));
            let username = String::from_utf16_lossy(chars);
            WTSFreeMemory(up.as_ptr() as _);
            if username.trim().is_empty() || username.eq_ignore_ascii_case("system") {
                continue;
            }
            out.push(SessionInfo {
                session_id: session.SessionId.to_string(),
                username,
                state: "active".to_owned(),
                seat_id: Some(format!("seat-{}", session.SessionId)),
                display: None,
            });
        }
        WTSFreeMemory(p as _);
        Ok(out)
    }
}
#[cfg(not(windows))]
fn windows_sessions() -> Result<Vec<SessionInfo>, Box<dyn std::error::Error + Send + Sync>> {
    Ok(Vec::new())
}
async fn start_session(
    s: &AppState,
    session_id: &str,
) -> Result<RemoteSession, Box<dyn std::error::Error + Send + Sync>> {
    let id: u32 = session_id.parse()?;
    let mut session = session_supervisor::ensure_session(s, id).await?;
    let ticket = uuid::Uuid::new_v4().to_string();
    s.vnc_tickets
        .lock()
        .await
        .insert(ticket.clone(), (id, Instant::now() + VNC_TICKET_TTL));
    session.vnc_ticket = ticket;
    Ok(session)
}
#[cfg(windows)]
fn spawn_worker(
    session_id: u32,
    port: u16,
    password: &str,
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
            .map_err(|e| format!("WTSQueryUserToken(session {session_id}) failed: {e}"))?;
        let exe = env::current_exe()?.with_file_name("msm-agent-worker.exe");
        let command = format!(
            "\"{}\" --session-id {} --port {} --password {}",
            exe.display(),
            session_id,
            port,
            password
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
        .map_err(|e| format!("CreateProcessAsUserW(session {session_id}) failed: {e}"))?;
        let pid = process.dwProcessId;
        CloseHandle(process.hThread)?;
        CloseHandle(process.hProcess)?;
        CloseHandle(token)?;
        Ok(pid)
    }
}
#[cfg(not(windows))]
fn spawn_worker(_: u32, _: u16, _: &str) -> Result<u32, Box<dyn std::error::Error + Send + Sync>> {
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
            Ok(p) => {
                if let Err(e) = TerminateProcess(p, 1) {
                    warn!(pid,%e,"failed to terminate VNC worker");
                }
                let _ = CloseHandle(p);
            }
            Err(e) => warn!(pid,%e,"failed to open VNC worker for termination"),
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
        .route("/vnc/{session_id}", any(vnc_websocket))
        .with_state(state.clone());
    session_supervisor::start(state);
    Ok((app, identity))
}
async fn run_server(
    listen: SocketAddr,
    tls_cert: Option<PathBuf>,
    tls_key: Option<PathBuf>,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    ready: Option<oneshot::Sender<Result<(), String>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (app, identity) = build_app().await?;
    match (tls_cert, tls_key) {
        (Some(cert), Some(key)) => {
            let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert, &key)
                .await
                .map_err(|e| format!("TLS configuration failed: {e}"))?;
            let listener = std::net::TcpListener::bind(listen)?;
            listener.set_nonblocking(true)?;
            if let Some(tx) = ready {
                let _ = tx.send(Ok(()));
            }
            info!(device_id=%identity.device_id,device_name=%identity.device_name,listen=%listen,"MSM Windows agent started with TLS");
            let handle = axum_server::Handle::new();
            let server = axum_server::from_tcp_rustls(listener, config)?
                .handle(handle.clone())
                .serve(app.into_make_service());
            tokio::select! { result=server=>result?,_=shutdown=>{handle.graceful_shutdown(Some(Duration::from_secs(30)));} }
            Ok(())
        }
        (None, None) => {
            let listener = match tokio::net::TcpListener::bind(listen).await {
                Ok(l) => l,
                Err(e) => {
                    if let Some(tx) = ready {
                        let _ = tx.send(Err(e.to_string()));
                    }
                    return Err(e.into());
                }
            };
            if let Some(tx) = ready {
                let _ = tx.send(Ok(()));
            }
            info!(device_id=%identity.device_id,device_name=%identity.device_name,listen=%listen,"MSM Windows agent started without TLS (development mode)");
            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown)
                .await?;
            Ok(())
        }
        _ => Err("TLS requires both --tls-cert and --tls-key".into()),
    }
}
#[cfg(windows)]
fn install_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::{ffi::OsString, path::PathBuf};
    use windows_service::{
        service::{ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceType},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    let m = ServiceManager::local_computer(
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
        executable_path: PathBuf::from(&executable_path),
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
    if let Ok(existing) = m.open_service(SERVICE_NAME, access) {
        let _ = existing.stop();
        let _ = existing.delete();
        drop(existing);
        std::thread::sleep(Duration::from_millis(500));
    }
    let service = m.create_service(&info, access)?;
    service.set_description(SERVICE_DESCRIPTION)?;
    println!("MSM Agent service installed.");
    Ok(())
}
#[cfg(windows)]
fn uninstall_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use windows_service::{
        service::{ServiceAccess, ServiceState},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    let m = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let s = match m.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        Ok(s) => s,
        Err(e) => {
            println!("MSM Agent service is not installed: {e}");
            return Ok(());
        }
    };
    if s.query_status()?.current_state != ServiceState::Stopped {
        let _ = s.stop();
    }
    s.delete()?;
    println!("MSM Agent service uninstalled.");
    Ok(())
}
#[cfg(windows)]
fn start_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use windows_service::{
        service::ServiceAccess,
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    let m = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    m.open_service(
        SERVICE_NAME,
        ServiceAccess::START | ServiceAccess::QUERY_STATUS,
    )?
    .start::<&str>(&[])?;
    println!("MSM Agent service start requested.");
    Ok(())
}
#[cfg(windows)]
fn stop_windows_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use windows_service::{
        service::ServiceAccess,
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    let m = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let _ = m
        .open_service(
            SERVICE_NAME,
            ServiceAccess::STOP | ServiceAccess::QUERY_STATUS,
        )?
        .stop()?;
    println!("MSM Agent service stop requested.");
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
        let status_handle =
            match service_control_handler::register(SERVICE_NAME, move |e| match e {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    let _ = stop_tx.send(());
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("failed to register MSM service control handler: {e}");
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
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("failed to create Tokio runtime for MSM service: {e}");
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
            SERVICE_LISTEN
                .parse()
                .expect("valid service listen address"),
            None,
            None,
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
            Ok(r) => r,
            Err(e) => Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
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
    tracing_subscriber::fmt::init();
    let args = Args::parse();
    if args.print_identity {
        let i = load_or_create_identity()?;
        let t = load_or_create_token()?;
        println!("{}", serde_json::to_string_pretty(&i)?);
        println!("access_token={t}");
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
    if args.tls_cert.is_some() != args.tls_key.is_some() {
        return Err("--tls-cert and --tls-key must be provided together".into());
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_server(
        args.listen,
        args.tls_cert,
        args.tls_key,
        async {
            let _ = signal::ctrl_c().await;
        },
        None,
    ))
}
