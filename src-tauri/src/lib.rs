use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> Result<AppInfo, String> {
    let package_info = app.package_info();
    Ok(AppInfo {
        version: package_info.version.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

#[tauri::command]
fn credential_set(key: String, secret: String) -> Result<(), String> {
    keyring::Entry::new("MSM", &key)
        .map_err(|e| e.to_string())?
        .set_password(&secret)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn credential_get(key: String) -> Result<Option<String>, String> {
    match keyring::Entry::new("MSM", &key)
        .map_err(|e| e.to_string())?
        .get_password()
    {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn credential_delete(key: String) -> Result<(), String> {
    match keyring::Entry::new("MSM", &key)
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn clipboard_get() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.get_text().map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_set(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            credential_set,
            credential_get,
            credential_delete,
            clipboard_get,
            clipboard_set
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_title("MSM — Remote Monitor & Control")?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MSM");
}
