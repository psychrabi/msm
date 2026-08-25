// In release builds the per-session worker uses the Windows GUI subsystem so
// no console window is created when the system service launches a worker.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{env, error::Error, time::Duration};

use clap::Parser;
use enigo::{Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use rustvncserver::{server::ServerEvent, VncServer};
use tracing::{error, info, warn};
use xcap::Monitor;

#[derive(Debug, Parser, Clone)]
#[command(
    name = "msm-agent-worker",
    about = "MSM per-session Windows desktop worker"
)]
struct Args {
    #[arg(long)]
    session_id: u32,
    #[arg(long)]
    port: u16,
    #[arg(long)]
    password: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();
    if env::consts::OS != "windows" {
        return Err("Windows only".into());
    }

    let monitors = Monitor::all()?;
    let primary = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or("no primary display available")?;
    let width = primary.width()?.min(u16::MAX as u32) as u16;
    let height = primary.height()?.min(u16::MAX as u32) as u16;

    let (server, mut events) = VncServer::new(
        width,
        height,
        format!("MSM Session {}", args.session_id),
        Some(args.password.clone()),
    );
    let server = std::sync::Arc::new(server);

    info!(
        session_id = args.session_id,
        port = args.port,
        width,
        height,
        "VNC worker starting"
    );

    let event_server = server.clone();
    let event_session_id = args.session_id;
    tokio::spawn(async move {
        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(value) => value,
            Err(error) => {
                error!(?error, "unable to initialize Windows input backend");
                return;
            }
        };
        let mut previous_button_mask = 0u8;

        while let Some(event) = events.recv().await {
            match event {
                ServerEvent::PointerMove {
                    x, y, button_mask, ..
                } => {
                    let _ = enigo.move_mouse(x as i32, y as i32, Coordinate::Abs);
                    apply_button_transitions(previous_button_mask, button_mask);
                    previous_button_mask = button_mask;
                }
                ServerEvent::KeyPress { key, down, .. } => {
                    if let Some(mapped) = map_keysym(key) {
                        let direction = if down {
                            Direction::Press
                        } else {
                            Direction::Release
                        };
                        let _ = enigo.key(mapped, direction);
                    } else {
                        warn!(key, "unmapped VNC key symbol");
                    }
                }
                ServerEvent::ClipboardReceived { text, .. } => {
                    if let Err(error) = set_windows_clipboard(&text) {
                        warn!(
                            session_id = event_session_id,
                            ?error,
                            "unable to update Windows clipboard from VNC client"
                        );
                    }
                }
                ServerEvent::ClientConnected { client_id } => {
                    previous_button_mask = 0;
                    info!(
                        session_id = event_session_id,
                        client_id,
                        "VNC client connected"
                    );
                }
                ServerEvent::ClientDisconnected { .. } => {
                    if previous_button_mask != 0 {
                        apply_button_transitions(previous_button_mask, 0);
                        previous_button_mask = 0;
                    }
                }
                _ => {}
            }
        }

        drop(event_server);
    });

    // Bridge the clipboard belonging to this interactive Windows session into
    // the VNC server. The worker runs under the logged-in user's token, so the
    // clipboard APIs operate on that user's clipboard rather than LocalSystem.
    let clipboard_server = server.clone();
    let clipboard_session_id = args.session_id;
    std::thread::spawn(move || {
        let mut last_text: Option<String> = None;
        loop {
            if let Some(text) = get_windows_clipboard() {
                let changed = last_text.as_ref() != Some(&text);
                if changed {
                    clipboard_server.send_clipboard(&text);
                    last_text = Some(text);
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });

    let capture_server = server.clone();
    let runtime = tokio::runtime::Handle::current();
    let session_id = args.session_id;
    let capture_width = width;
    let capture_height = height;
    std::thread::spawn(move || {
        let monitors = match Monitor::all() {
            Ok(value) => value,
            Err(error) => {
                error!(
                    session_id,
                    ?error,
                    "unable to enumerate monitors in capture thread"
                );
                return;
            }
        };
        let monitor = match monitors
            .into_iter()
            .find(|m| m.is_primary().unwrap_or(false))
        {
            Some(value) => value,
            None => {
                error!(session_id, "no primary display available in capture thread");
                return;
            }
        };

        loop {
            match monitor.capture_image() {
                Ok(image) => {
                    if image.width() == capture_width as u32
                        && image.height() == capture_height as u32
                    {
                        if let Err(error) = runtime.block_on(
                            capture_server
                                .framebuffer()
                                .update_from_slice(image.as_raw()),
                        ) {
                            warn!(session_id, ?error, "framebuffer update failed");
                        }
                    } else {
                        warn!(
                            session_id,
                            width = image.width(),
                            height = image.height(),
                            "capture dimensions changed; frame skipped"
                        );
                    }
                }
                Err(error) => warn!(session_id, ?error, "screen capture failed"),
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });

    server.listen(args.port).await?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn get_windows_clipboard() -> Option<String> {
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }

        let result = if IsClipboardFormatAvailable(CF_UNICODETEXT).is_ok() {
            let handle = match GetClipboardData(CF_UNICODETEXT) {
                Ok(value) => value,
                Err(_) => {
                    let _ = CloseClipboard();
                    return None;
                }
            };
            let size = GlobalSize(handle.0 as _);
            let ptr = GlobalLock(handle.0 as _);
            if ptr.is_null() || size == 0 {
                if !ptr.is_null() {
                    let _ = GlobalUnlock(handle.0 as _);
                }
                None
            } else {
                let max_units = (size as usize) / std::mem::size_of::<u16>();
                let slice = std::slice::from_raw_parts(ptr as *const u16, max_units);
                let len = slice.iter().position(|value| *value == 0).unwrap_or(max_units);
                let text = String::from_utf16_lossy(&slice[..len]);
                let _ = GlobalUnlock(handle.0 as _);
                Some(text)
            }
        } else {
            None
        };

        let _ = CloseClipboard();
        result
    }
}

#[cfg(not(target_os = "windows"))]
fn get_windows_clipboard() -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn set_windows_clipboard(text: &str) -> Result<(), Box<dyn Error + Send + Sync>> {
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::Win32::Foundation::HANDLE;

    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);

    unsafe {
        OpenClipboard(None)?;
        if let Err(error) = EmptyClipboard() {
            let _ = CloseClipboard();
            return Err(error.into());
        }

        let memory = match GlobalAlloc(GMEM_MOVEABLE, wide.len() * std::mem::size_of::<u16>()) {
            Ok(value) => value,
            Err(error) => {
                let _ = CloseClipboard();
                return Err(error.into());
            }
        };
        let ptr = GlobalLock(memory);
        if ptr.is_null() {
            let _ = CloseClipboard();
            return Err(std::io::Error::last_os_error().into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr as *mut u16, wide.len());
        let _ = GlobalUnlock(memory);

        if let Err(error) = SetClipboardData(CF_UNICODETEXT, Some(HANDLE(memory.0))) {
            let _ = CloseClipboard();
            return Err(error.into());
        }

        // Ownership transfers to the Windows clipboard after SetClipboardData.
        let _ = CloseClipboard();
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_windows_clipboard(_text: &str) -> Result<(), Box<dyn Error + Send + Sync>> {
    Err("Windows only".into())
}

#[cfg(target_os = "windows")]
fn apply_button_transitions(previous_mask: u8, current_mask: u8) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, mouse_event,
    };

    let transitions = [
        (1u8, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, "left"),
        (2u8, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, "middle"),
        (4u8, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, "right"),
    ];

    for (bit, down_flag, up_flag, name) in transitions {
        let was_pressed = previous_mask & bit != 0;
        let is_pressed = current_mask & bit != 0;

        if was_pressed == is_pressed {
            continue;
        }

        let flag = if is_pressed { down_flag } else { up_flag };
        unsafe {
            mouse_event(flag, 0, 0, 0, 0);
        }
        info!(
            previous_mask,
            current_mask,
            button = name,
            pressed = is_pressed,
            "VNC mouse button transition"
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_button_transitions(_previous_mask: u8, _current_mask: u8) {}

fn map_keysym(key: u32) -> Option<Key> {
    let mapped = match key {
        0xff08 => Key::Backspace,
        0xff09 => Key::Tab,
        0xff0d => Key::Return,
        0xff1b => Key::Escape,
        0xff50 => Key::Home,
        0xff51 => Key::LeftArrow,
        0xff52 => Key::UpArrow,
        0xff53 => Key::RightArrow,
        0xff54 => Key::DownArrow,
        0xff55 => Key::PageUp,
        0xff56 => Key::PageDown,
        0xff57 => Key::End,
        0xff63 => Key::Insert,
        0xffff => Key::Delete,
        0xffbe => Key::F1,
        0xffbf => Key::F2,
        0xffc0 => Key::F3,
        0xffc1 => Key::F4,
        0xffc2 => Key::F5,
        0xffc3 => Key::F6,
        0xffc4 => Key::F7,
        0xffc5 => Key::F8,
        0xffc6 => Key::F9,
        0xffc7 => Key::F10,
        0xffc8 => Key::F11,
        0xffc9 => Key::F12,
        0xffe1 => Key::Shift,
        0xffe2 => Key::RShift,
        0xffe3 => Key::Control,
        0xffe4 => Key::RControl,
        0xffe9 => Key::Alt,
        0xffea => Key::Alt,
        0xffeb => Key::Meta,
        0xffec => Key::Meta,
        0x20 => Key::Space,
        0x21..=0x7e => Key::Unicode(char::from_u32(key)?),
        _ => return None,
    };
    Some(mapped)
}