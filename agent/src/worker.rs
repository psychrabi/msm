use std::{env, error::Error, time::Duration};

use clap::Parser;
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use rustvncserver::{server::ServerEvent, VncServer};
use tracing::{error, info, warn};
use xcap::Monitor;

#[derive(Debug, Parser)]
#[command(name = "msm-agent-worker", about = "MSM per-session Windows desktop worker")]
struct Args {
    #[arg(long)] session_id: u32,
    #[arg(long)] port: u16,
    #[arg(long)] password: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();
    if env::consts::OS != "windows" {
        return Err("Windows only".into());
    }

    let monitors = Monitor::all()?;
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned()
        .or_else(|| monitors.into_iter().next())
        .ok_or("no display available")?;
    let width = monitor.width()?.min(u16::MAX as u32) as u16;
    let height = monitor.height()?.min(u16::MAX as u32) as u16;

    let (server, mut events) = VncServer::new(
        width,
        height,
        format!("MSM Session {}", args.session_id),
        Some(args.password.clone()),
    );
    let server = std::sync::Arc::new(server);

    info!(session_id=args.session_id, port=args.port, width, height, "VNC worker starting");

    let input_server = server.clone();
    tokio::spawn(async move {
        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(value) => value,
            Err(error) => {
                error!(?error, "unable to initialize Windows input backend");
                return;
            }
        };

        while let Some(event) = events.recv().await {
            match event {
                ServerEvent::PointerMove { x, y, button_mask, .. } => {
                    let _ = enigo.move_mouse(x as i32, y as i32, Coordinate::Abs);
                    apply_buttons(&mut enigo, button_mask);
                }
                ServerEvent::KeyPress { key, down, .. } => {
                    if let Some(mapped) = map_keysym(key) {
                        let direction = if down { Direction::Press } else { Direction::Release };
                        let _ = enigo.key(mapped, direction);
                    } else {
                        warn!(key, "unmapped VNC key symbol");
                    }
                }
                ServerEvent::ClientConnected { client_id } => {
                    info!(session_id=args.session_id, client_id, "VNC client connected");
                }
                ServerEvent::ClientDisconnected { .. } => {}
                _ => {}
            }
        }

        // rustvncserver 2.2.1 does not expose a public stop() method.
        // Dropping the server is the shutdown mechanism.
        drop(input_server);
    });

    let capture_server = server.clone();
    std::thread::spawn(move || loop {
        match monitor.capture_image() {
            Ok(image) => {
                let w = image.width().min(u16::MAX as u32) as u16;
                let h = image.height().min(u16::MAX as u32) as u16;
                let framebuffer = capture_server.framebuffer_mut();
                framebuffer.set_data(image.as_raw());
                framebuffer.update_rect(0, 0, w, h);
            }
            Err(error) => warn!(?error, "screen capture failed"),
        }
        std::thread::sleep(Duration::from_millis(100));
    });

    server.listen(args.port).await?;
    Ok(())
}

fn apply_buttons(enigo: &mut Enigo, mask: u8) {
    for (bit, button) in [
        (1u8, Button::Left),
        (2u8, Button::Middle),
        (4u8, Button::Right),
    ] {
        let direction = if mask & bit != 0 {
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
