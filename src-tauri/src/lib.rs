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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![app_info])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_title("MSM — Remote Monitor & Control")?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MSM");
}
