use std::{env, fs, io, net::SocketAddr, path::PathBuf};

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, any},
    Json, Router,
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use tokio::{process::Command, signal};
use tracing::{info, warn};
use uuid::Uuid;

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_LISTEN: &str = "127.0.0.1:40123";

#[derive(Debug, Parser)]
#[command(name = "msm-agent", version, about = "MSM headless machine agent")]
struct Args {
    /// Address for the development control API.
    #[arg(long, default_value = DEFAULT_LISTEN)]
    listen: SocketAddr,

    /// Print the persisted device identity and exit.
    #[arg(long)]
    print_identity: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity {
    device_id: Uuid,
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

#[derive(Clone)]
struct AppState {
    identity: DeviceIdentity,
    auth_token: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage {
    Hello { identity: DeviceIdentity },
    Sessions { sessions: Vec<SessionInfo> },
    Error { message: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    ListSessions,
    Ping,
}

fn identity_path() -> Result<PathBuf, io::Error> {
    let base = dirs::data_local_dir().or_else(dirs::data_dir).ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "unable to determine local data directory")
    })?;
    Ok(base.join("MSM").join("agent").join("identity.json"))
}

fn token_path() -> Result<PathBuf, io::Error> {
    let base = dirs::data_local_dir().or_else(dirs::data_dir).ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "unable to determine local data directory")
    })?;
    Ok(base.join("MSM").join("agent").join("access-token"))
}

fn load_or_create_identity() -> Result<DeviceIdentity, Box<dyn std::error::Error>> {
    let path = identity_path()?;

    if let Ok(contents) = fs::read_to_string(&path) {
        return Ok(serde_json::from_str::<DeviceIdentity>(&contents)?);
    }

    let identity = DeviceIdentity {
        device_id: Uuid::new_v4(),
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

fn load_or_create_token() -> Result<String, Box<dyn std::error::Error>> {
    let path = token_path()?;

    if let Ok(token) = fs::read_to_string(&path) {
        let token = token.trim().to_owned();
        if !token.is_empty() {
            return Ok(token);
        }
    }

    let token = Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, &token)?;
    Ok(token)
}

fn hostname() -> String {
    #[cfg(windows)]
    {
        env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_owned())
    }

    #[cfg(not(windows))]
    {
        env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_owned())
    }
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
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "unauthorized" })));
    }

    (StatusCode::OK, Json(serde_json::json!({
        "status": "ok",
        "device": state.identity,
    })))
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
    let hello = serde_json::to_string(&ServerMessage::Hello {
        identity: state.identity.clone(),
    });
    if let Ok(message) = hello {
        if socket.send(Message::Text(message.into())).await.is_err() {
            return;
        }
    }

    while let Some(Ok(message)) = socket.recv().await {
        let Message::Text(text) = message else {
            continue;
        };

        let response = match serde_json::from_str::<ClientMessage>(&text) {
            Ok(ClientMessage::ListSessions) => {
                ServerMessage::Sessions {
                    sessions: discover_sessions().await,
                }
            }
            Ok(ClientMessage::Ping) => ServerMessage::Hello {
                identity: state.identity.clone(),
            },
            Err(error) => ServerMessage::Error {
                message: format!("invalid request: {error}"),
            },
        };

        if let Ok(payload) = serde_json::to_string(&response) {
            if socket.send(Message::Text(payload.into())).await.is_err() {
                break;
            }
        }
    }
}

async fn discover_sessions() -> Vec<SessionInfo> {
    #[cfg(target_os = "windows")]
    {
        return discover_windows_sessions().await;
    }

    #[cfg(target_os = "linux")]
    {
        return discover_linux_sessions().await;
    }

    #[cfg(target_os = "macos")]
    {
        return discover_unix_sessions().await;
    }

    #[allow(unreachable_code)]
    Vec::new()
}

#[cfg(target_os = "windows")]
async fn discover_windows_sessions() -> Vec<SessionInfo> {
    let output = match Command::new("quser").output().await {
        Ok(output) if output.status.success() => output,
        _ => return Vec::new(),
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 4 {
                return None;
            }
            let username = fields[0].trim_start_matches('>').to_owned();
            let session_id = fields.get(2)?.to_string();
            let state = fields.get(3)?.to_lowercase();
            Some(SessionInfo {
                session_id,
                username,
                state,
                seat_id: None,
                display: None,
            })
        })
        .collect()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn discover_unix_sessions() -> Vec<SessionInfo> {
    let output = match Command::new("who").output().await {
        Ok(output) if output.status.success() => output,
        _ => return Vec::new(),
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let username = fields.first()?.to_string();
            let tty = fields.get(1)?.to_string();
            let display = tty.strip_prefix("tty").map(str::to_owned);
            Some(SessionInfo {
                session_id: tty.clone(),
                username,
                state: "active".to_owned(),
                seat_id: None,
                display,
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
async fn discover_linux_sessions() -> Vec<SessionInfo> {
    let output = Command::new("loginctl")
        .args(["list-sessions", "--no-legend"])
        .output()
        .await;

    let Ok(output) = output else {
        return discover_unix_sessions().await;
    };

    if !output.status.success() {
        return discover_unix_sessions().await;
    }

    let mut sessions = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let Some(session_id) = fields.first() else { continue };
        let username = fields.get(2).copied().unwrap_or("unknown");
        let details = Command::new("loginctl")
            .args(["show-session", session_id, "--property=State", "--property=Name", "--property=Remote", "--value"])
            .output()
            .await;

        let (state, name) = match details {
            Ok(details) if details.status.success() => {
                let values: Vec<&str> = String::from_utf8_lossy(&details.stdout).lines().collect();
                (
                    values.first().copied().unwrap_or("unknown").to_owned(),
                    values.get(1).copied().unwrap_or(username).to_owned(),
                )
            }
            _ => ("unknown".to_owned(), username.to_owned()),
        };

        sessions.push(SessionInfo {
            session_id: (*session_id).to_owned(),
            username: name,
            state,
            seat_id: None,
            display: None,
        });
    }

    sessions
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();
    let identity = load_or_create_identity()?;
    let auth_token = load_or_create_token()?;

    if args.print_identity {
        println!("{}", serde_json::to_string_pretty(&identity)?);
        println!("access_token={auth_token}");
        return Ok(());
    }

    let state = AppState {
        identity: identity.clone(),
        auth_token,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", any(websocket))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    info!(
        device_id = %identity.device_id,
        device_name = %identity.device_name,
        platform = %identity.platform,
        listen = %args.listen,
        "MSM agent control endpoint started"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = signal::ctrl_c().await;
            warn!("shutdown requested");
        })
        .await?;

    Ok(())
}
