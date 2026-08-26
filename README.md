# MSM

MSM is a VNC-based remote monitor and control application for Windows multiseat workstations.

## Architecture

MSM is one Git repository containing two independently runnable applications:

```text
msm/
├── agent/          # headless Rust Windows machine agent + per-session worker
├── src-tauri/      # Tauri desktop viewer backend
├── src/            # React/TypeScript viewer UI
└── docs/           # architecture and release documentation
```

The **viewer** is installed on the operator computer. The **agent** is installed independently on every Windows computer that should be remotely monitored or controlled.

```text
                 MSM Viewer
              Tauri + React
                    │
                  WSS
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      Agent A     Agent B     Agent C
        │           │           │
     Sessions    Sessions    Sessions
```

## Windows-only scope

The current product target is **Windows only**. Linux and macOS implementations are intentionally not maintained at this stage.

## Current stack

- Rust for the machine agent, per-session worker, VNC/RFB server integration, and Windows integration.
- Tauri 2 for the desktop viewer shell.
- React + TypeScript + Vite for the viewer UI.
- `rustvncserver` for RFB/VNC server functionality.
- `xcap` for Windows desktop capture.
- `enigo` for Windows keyboard/mouse input injection.
- `windows` crate for Windows Terminal Services/session APIs, user-session process creation, DPAPI, and clipboard integration.
- `@novnc/novnc` for the viewer-side VNC client.
- Native Windows credential storage for viewer-side persisted agent credentials.
- Native rustls TLS for Agent transport encryption.

## Multiseat model

A physical Windows computer can contain multiple independent logged-in sessions. Each session is a first-class remote-control target.

```text
Device
├── Agent service (LocalSystem)
│   ├── Seat 1 / Session 1
│   │   └── msm-agent-worker → VNC :5901
│   ├── Seat 2 / Session 2
│   │   └── msm-agent-worker → VNC :5902
│   └── Seat 3 / Session 3
│       └── msm-agent-worker → VNC :5903
```

The Windows service remains running independently of interactive user sessions. It discovers eligible sessions and launches workers in the corresponding user's Windows session. If a worker exits unexpectedly, bounded watchdog backoff restores it without creating an unbounded spawn loop.

## Agent security

Production service mode requires TLS certificate and private key files:

```text
C:\ProgramData\MSM\agent\tls\cert.pem
C:\ProgramData\MSM\agent\tls\key.pem
```

The Agent token is stored with Windows DPAPI machine protection. Legacy plaintext token files are migrated on startup. Worker VNC passwords are random and independent from the Agent token. Viewer VNC connections use short-lived session-bound tickets rather than placing the long-lived Agent token in the VNC URL.

The worker VNC port range is loopback-only by design and is blocked by the installer firewall rule from inbound network access. Remote access should use the authenticated Agent WSS proxy.

## Local development

The Agent can still be run without TLS for local development:

```powershell
cargo run -p msm-agent -- --listen 127.0.0.1:40123
```

This development mode is intentionally not a production network configuration.

For a TLS Agent, provide both files:

```powershell
cargo run -p msm-agent -- \
  --listen 0.0.0.0:40123 \
  --tls-cert C:\secure\cert.pem \
  --tls-key C:\secure\key.pem
```

The Viewer production endpoint is:

```text
wss://<agent-host>:40123/ws
```

## Windows service installation

Build both binaries and provision the TLS assets out-of-band:

```powershell
.\packaging\windows\install-agent.ps1 `
  -AgentBinaryPath .\target\release\msm-agent.exe `
  -WorkerBinaryPath .\target\release\msm-agent-worker.exe `
  -TlsCertificatePath C:\secure\msm-agent-cert.pem `
  -TlsPrivateKeyPath C:\secure\msm-agent-key.pem
```

The installer registers `msm-agent` as a LocalSystem Windows service, configures automatic service recovery, applies restrictive data-directory ACLs, permits the TLS Agent port, and blocks inbound access to the internal VNC port range.

Subsequent upgrades preserve the existing TLS certificate and key when replacement paths are omitted.

## Viewer

Install dependencies and start the Tauri application:

```bash
bun install
bun run tauri dev
```

On the first connection, enter the Agent WSS URL and the access token printed by `--print-identity` during controlled provisioning. Enable **Remember** to persist the connection in the viewer's native credential store.

Saved credentials are associated with the Agent endpoint. **Forget** removes the saved endpoint and its native credential. If an Agent rejects a saved credential with `401 Unauthorized`, the viewer clears that credential instead of retrying indefinitely.

Sessions are **not** opened automatically when the Agent connects. Switching pages or sessions does not implicitly reconnect or replace an existing remote viewer.

The default viewer mode is **View only**. Control mode can be enabled explicitly.

## Production gates

GitHub Actions now validates:

- frontend dependency installation and production build;
- workspace Rust compilation and tests;
- Windows Agent release compilation;
- Tauri application build;
- Agent packaging script.

The final release procedure is documented in [`docs/release-checklist.md`](docs/release-checklist.md), with security and operational details in [`docs/production-hardening.md`](docs/production-hardening.md).

A production release additionally requires clean-machine installer testing, TLS certificate validation, Windows code signing, a representative soak test, and completion of every checklist item.
