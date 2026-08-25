use std::{env, error::Error, time::Duration};

use clap::Parser;
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use rustvncserver::{VncServer, server::ServerEvent};
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
                    apply_button_transitions(&mut enigo, previous_button_mask, button_mask);
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
                ServerEvent::ClientConnected { client_id } => {
                    previous_button_mask = 0;
                    info!(
                        session_id = args.session_id,
                        client_id, "VNC client connected"
                    );
                }
                ServerEvent::ClientDisconnected { .. } => {
                    if previous_button_mask != 0 {
                        apply_button_transitions(&mut enigo, previous_button_mask, 0);
                        previous_button_mask = 0;
                    }
                }
                _ => {}
            }
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

fn apply_button_transitions(enigo: &mut Enigo, previous_mask: u8, current_mask: u8) {
    for (bit, button) in [
        (1u8, Button::Left),
        (2u8, Button::Middle),
        (4u8, Button::Right),
    ] {
        let was_pressed = previous_mask & bit != 0;
        let is_pressed = current_mask & bit != 0;

        if was_pressed == is_pressed {
            continue;
        }

        let direction = if is_pressed {
            Direction::Press
        } else {
            Direction::Release
        };
        let _ = enigo.button(button, direction);
    }
}

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
