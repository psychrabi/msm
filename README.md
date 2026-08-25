# MSM

MSM is a VNC-based remote monitor and control application designed for multiseat workstations.

## Architecture

MSM is a single Git repository containing two independently runnable applications:

```text
msm/
├── agent/          # headless Rust machine agent
├── src-tauri/      # Tauri desktop viewer backend
├── src/            # React/TypeScript viewer UI
└── docs/
```

The **viewer** is an operator application. The **agent** is installed independently on computers that need to be remotely monitored or controlled.

```text
                 MSM Viewer
              Tauri + React
                    │
             WebSocket control
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      Agent A     Agent B     Agent C
        │           │           │
      Seats       Seats       Seats
```

There is intentionally no CI/CD yet. Development is local and Git-based.

## Current stack

- Rust for the application core, machine agent, VNC/RFB work, and native OS integration.
- Tauri 2 for the desktop application shell.
- React + TypeScript + Vite for the UI.
- PostgreSQL for server-side persistence when the management backend is introduced.
- Prefer established Tauri plugins and mature Rust crates over custom infrastructure.

## Multiseat model

A physical device can contain multiple independent user sessions. Each session is a first-class remote-control target.

```text
Device
├── Seat 1
│   └── Session A
│       └── VNC server
├── Seat 2
│   └── Session B
│       └── VNC server
└── Seat 3
    └── Session C
        └── VNC server
```

Session identity must not depend on a VNC TCP port. Ports/sockets are implementation details owned by the agent.

## Agent

The standalone agent currently provides:

- Persistent device identity.
- Persistent local access token for development pairing.
- Authenticated HTTP health endpoint.
- Authenticated WebSocket control endpoint.
- Cross-platform baseline session discovery.
  - Windows: `quser`.
  - Linux: `loginctl`, with `who` fallback.
  - macOS: `who`.
- JSON control messages for device information and session discovery.

Run it locally:

```bash
cargo run -p msm-agent
```

Print the device identity and development access token:

```bash
cargo run -p msm-agent -- --print-identity
```

The default development endpoint is:

```text
ws://127.0.0.1:40123/ws
```

To test another computer on a LAN, explicitly bind the agent to a reachable address:

```bash
cargo run -p msm-agent -- --listen 0.0.0.0:40123
```

The current LAN endpoint is intended for development only. It uses a bearer token but does not yet provide TLS or a production relay. Do not expose it directly to the public Internet.

## Viewer

Install dependencies and start the Tauri application:

```bash
npm install
npm run tauri dev
```

Enter the agent WebSocket URL and the token printed by `--print-identity`. The viewer will connect to the standalone agent and display its discovered sessions.

## Current implementation boundary

The distributed control path and session discovery are implemented before VNC framebuffer transport. The next transport layer should use established VNC/RFB libraries rather than a custom protocol implementation. A current candidate is `rustvncserver`, which provides an async Rust RFB server with standard VNC encodings and framebuffer APIs.

Screen capture and input injection remain deliberately OS/session-specific. They must be implemented so that a VNC instance attached to one multiseat session cannot capture or inject into another user's session.
