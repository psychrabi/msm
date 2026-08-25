use std::{env, fs, io, path::PathBuf};

use serde::{Deserialize, Serialize};
use tokio::time::{sleep, Duration};
use tracing::{info, warn};
use uuid::Uuid;

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity {
    device_id: Uuid,
    device_name: String,
    platform: String,
    architecture: String,
    agent_version: String,
}

fn identity_path() -> Result<PathBuf, io::Error> {
    let base = dirs::data_local_dir().or_else(dirs::data_dir).ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "unable to determine local data directory")
    })?;
    Ok(base.join("MSM").join("agent").join("identity.json"))
}

fn load_or_create_identity() -> Result<DeviceIdentity, Box<dyn std::error::Error>> {
    let path = identity_path()?;

    if let Ok(contents) = fs::read_to_string(&path) {
        let identity = serde_json::from_str::<DeviceIdentity>(&contents)?;
        return Ok(identity);
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

    let json = serde_json::to_string_pretty(&identity)?;
    fs::write(path, json)?;

    Ok(identity)
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let identity = load_or_create_identity()?;
    info!(
        device_id = %identity.device_id,
        device_name = %identity.device_name,
        platform = %identity.platform,
        architecture = %identity.architecture,
        version = %identity.agent_version,
        "MSM agent started"
    );

    info!("session discovery and remote transport are not enabled yet");
    info!("agent is running in local development mode");

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("shutdown requested");
                break;
            }
            _ = sleep(Duration::from_secs(30)) => {
                warn!(device_id = %identity.device_id, "agent heartbeat: transport not configured");
            }
        }
    }

    Ok(())
}
