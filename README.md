# MSM

MSM is a VNC-based remote monitor and control application for Windows multiseat workstations.

## Architecture

MSM is one Git repository containing two independently runnable applications:

```text
msm/
├── agent/          # headless Rust Windows machine agent + worker
├── src-tauri/      # Tauri desktop viewer backend
├── src/            # React/TypeScript viewer UI
└── docs/
```

The **viewer** is installed on the operator computer. The **agent** is installed independently on every Windows computer that should be remotely monitored or controlled.

```text
                 MSM Viewer
              Tauri + React
                    │
             authenticated WS
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      Agent A     Agent B     Agent C
        │           │           │
     Sessions    Sessions    Sessions
```

There is intentionally no CI/CD. Development is local and Git-based.

## Windows-only scope

The current product target is **Windows only**. Linux and macOS implementations are intentionally not maintained at this stage.

## Current stack

- Rust for the machine agent, per-session worker, VNC/RFB server integration, and Windows integration.
- Tauri 2 for the desktop viewer shell.
- React + TypeScript + Vite for the viewer UI.
- `rustvncserver` for RFB/VNC server functionality.
- `xcap` for Windows desktop capture.
- `enigo` for Windows keyboard/mouse input injection.
- `windows` crate for Windows Terminal Services/session APIs and user-session process creation.
- `@novnc/novnc` for the viewer-side VNC client.
- Prefer established Tauri plugins and mature Rust crates over custom infrastructure.

## Multiseat model

A physical Windows computer can contain multiple independent logged-in sessions. Each session is a first-class remote-control target.

```text
Device
├── Seat 1
│   └── Session 1
│       └── msm-agent-worker → VNC :5901
├── Seat 2
│   └── Session 2
│       └── msm-agent-worker → VNC :5902
└── Seat 3
    └── Session 3
        └── msm-agent-worker → VNC :5903
```

The session ID is the durable identity. VNC ports are ephemeral implementation details owned by the agent.

## Agent

The standalone Windows agent provides:

- Persistent device identity.
- Persistent local development access token.
- Authenticated health endpoint.
- Authenticated WebSocket control endpoint.
- Windows Terminal Services session discovery.
- Per-session worker startup using the logged-in user's Windows token.
- Per-session VNC server lifecycle.
- Authenticated WebSocket-to-VNC proxy.

The worker runs inside the target user's Windows session. This is important: screen capture and input injection are performed in the target session rather than by a single machine-wide desktop process.

### Local development

Print the device identity and token:

```powershell
cargo run -p msm-agent -- --print-identity
```

Start the agent:

```powershell
cargo run -p msm-agent -- --listen 0.0.0.0:40123
```

The viewer connects to:

```text
ws://<agent-ip>:40123/ws
```

### Windows service installation

Build both binaries and use:

```powershell
.\packaging\windows\install-agent.ps1 \
  -AgentBinaryPath .\msm-agent.exe \
  -WorkerBinaryPath .\msm-agent-worker.exe
```

The installer registers the agent as a LocalSystem Windows service. The service uses the logged-in user's Windows session token to launch the per-session worker.

The installer also permits the agent control port and blocks inbound access to the internal VNC port range. The VNC ports are therefore implementation endpoints, not the intended remote-access interface.

## Viewer

Install dependencies and start the Tauri application:

```bash
npm install
npm run tauri dev
```

Enter the agent WebSocket URL and the token printed by `--print-identity`. The viewer discovers the active Windows sessions, starts a worker for the selected session, and embeds noVNC for the resulting remote desktop.

## Current remote desktop path

```text
Tauri Viewer
    │
    │ WebSocket control
    ▼
MSM Agent
    │
    │ session ID
    ▼
Windows session token
    │
    ▼
msm-agent-worker
    │
    ├── xcap → target desktop framebuffer
    ├── rustvncserver → RFB
    └── enigo ← keyboard/mouse
    │
    ▼
Agent WebSocket VNC proxy
    │
    ▼
noVNC in Viewer
```

The first implementation captures the primary monitor at a modest fixed frame cadence and supports basic mouse/keyboard input. Performance tuning, dirty-region capture, multi-monitor support, richer key mapping, clipboard, and production-grade transport security are subsequent hardening work.

The development control/VNC endpoints are not a production Internet security boundary yet. Do not expose them directly to the public Internet.
