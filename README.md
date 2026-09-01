# MSM

MSM is a Windows multiseat remote-monitoring and remote-control application. A Tauri desktop Viewer connects to one or more Windows Agents; each Agent runs as a LocalSystem service and supervises per-session/per-monitor VNC workers.

## Current release target

The current release target is a **trusted private-LAN deployment** using authenticated plain WebSocket:

```text
Viewer
  │
  └── ws://<agent-host>:40123/ws
          │
          ▼
     MSM Agent service
          │
          ├── session + monitor discovery
          ├── worker watchdog
          └── ws://.../vnc/<session>/<monitor>?ticket=...
                    │
                    ▼
             msm-agent-worker
```

The current transport is intentionally **not suitable for the public Internet or an untrusted network**. TLS/WSS is a deferred hardening milestone.

## Components

```text
msm/
├── agent/          # Rust Windows Agent + per-session/per-monitor worker
├── src-tauri/      # Tauri desktop Viewer backend
├── src/            # React/TypeScript Viewer UI
├── packaging/      # Windows Agent/application packaging
└── docs/           # Architecture, hardening, and release documentation
```

### Agent

The Agent provides persistent device identity and LAN access token, authenticated `/health` and `/ws`, Windows Terminal Services session discovery, monitor metadata discovery, worker lifecycle supervision with bounded backoff, short-lived session/monitor VNC tickets, and WebSocket-to-loopback-VNC proxying.

### Worker

Workers run inside the target user's Windows session. Each worker targets one monitor, captures it with `xcap`, serves it through `rustvncserver`, and translates remote mouse/keyboard input to the selected monitor's virtual-desktop coordinates. Workers publish monitor metadata including index, resolution, virtual-desktop position, and primary-display state.

Worker VNC ports are allocated from `5901-5999`, bind only to loopback, and are blocked inbound by the installer firewall rule.

### Viewer

The Viewer supports multiple Agents and sessions, multiple monitors per session, combined monitor cards, independent per-monitor VNC connections, fullscreen viewing, view-only/control modes, mouse/keyboard input, and bidirectional text clipboard bridging.

## Agent authentication

The Agent access token is currently stored as plaintext at:

```text
C:\ProgramData\MSM\agent\access-token
```

The installer keeps sensitive Agent identity/token files restricted to `SYSTEM` and `BUILTIN\Administrators`, while session workers are permitted to publish non-secret monitor metadata under the Agent data directory. The Viewer stores remembered credentials in the native Windows credential store rather than browser storage.

The Agent token is never reused as a VNC password. VNC access is granted through a short-lived, session/monitor-bound ticket returned by the authenticated control channel.

## Build

Requirements: Windows for the full Agent/worker path, Rust, Bun, and the normal Tauri prerequisites.

```powershell
bun install --frozen-lockfile
bun run build
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --release -p msm-agent
```

## Local Agent testing

```powershell
cargo run -p msm-agent -- --listen 127.0.0.1:40123
```

For controlled LAN testing:

```powershell
cargo run -p msm-agent -- --listen 0.0.0.0:40123
```

Release builds use the Windows GUI subsystem, so retrieve the token directly from:

```powershell
Get-Content C:\ProgramData\MSM\agent\access-token
```

## Windows Agent installation

From an elevated PowerShell session:

```powershell
.\packaging\windows\install-agent.ps1 `
  -AgentBinaryPath .\target\release\msm-agent.exe `
  -WorkerBinaryPath .\target\release\msm-agent-worker.exe
```

The installer stops old workers/service state, copies the binaries to `C:\Program Files\MSM`, preserves identity/token state, reapplies ACL/firewall/recovery configuration, installs `MSMAgent` as LocalSystem, and waits for `Running`.

Run the installation smoke test with:

```powershell
.\packaging\windows\test-agent-install.ps1
```

## Production gates

GitHub Actions validates frontend installation/build, Rust formatting/check/test/Clippy, Windows Agent release compilation, Tauri packaging, and Agent packaging.

Repository automation cannot replace physical Windows validation. Before release, complete the clean-install/upgrade/uninstall matrix, multi-session and multi-monitor tests, worker crash/recovery tests, reboot recovery, clipboard/input tests, a 24-hour soak, Windows signing, and artifact checksums.

See:

- `docs/architecture.md`
- `docs/production-hardening.md`
- `docs/release-checklist.md`
- `docs/release-validation.md`

## Security boundary

Do not expose TCP/40123 to the public Internet. Deferred hardening for an untrusted-network deployment includes TLS/WSS, DPAPI-backed Agent token storage, token rotation/revocation, certificate provisioning/SAN validation, bounded rotating service logs, and stronger Internet-facing authorization/network policy.
