# MSM

MSM is a Windows multiseat remote-monitoring and remote-viewing application. A Tauri desktop Viewer connects to one or more Windows Agents; each Agent runs as a LocalSystem service and supervises one VNC worker per eligible interactive Windows session.

## Current release target

The current release target is a **trusted private-LAN deployment**.

Agent control traffic uses authenticated plain WebSocket:

```text
Viewer
  │
  └── ws://<agent-host>:40123/ws
          │
          ▼
     MSM Agent service
          │
          ├── session discovery
          ├── worker watchdog
          └── ws://.../vnc/<session>?ticket=...
                    │
                    ▼
             msm-agent-worker
```

The current transport is intentionally **not suitable for the public Internet or an untrusted network**. TLS/WSS is a deferred hardening milestone.

## Components

```text
msm/
├── agent/          # Rust Windows Agent + per-session worker
├── src-tauri/      # Tauri desktop Viewer backend
├── src/            # React/TypeScript Viewer UI
├── packaging/      # Windows Agent/application packaging
└── docs/           # Architecture, hardening, and release documentation
```

### Agent

The Agent provides:

- persistent device identity;
- persistent LAN access token;
- authenticated `/health` endpoint;
- authenticated `/ws` control WebSocket;
- Windows Terminal Services session discovery;
- one worker per eligible interactive session;
- worker crash recovery with bounded exponential backoff;
- session disappearance cleanup;
- session-scoped VNC tickets with a five-minute TTL;
- WebSocket-to-loopback-VNC proxying;
- Windows service installation/start/stop/uninstall operations.

The Agent and worker are built as release Windows GUI-subsystem binaries, so operators should not depend on console output from installed services.

### Worker

Each worker runs in the target user's Windows session and owns the desktop/VNC path for that session. Worker credentials are randomly generated and are independent from the Agent access token.

The worker VNC ports are allocated from `5901-5999` and are expected to bind only to loopback. The installer also blocks inbound access to this range so remote viewers use the Agent proxy rather than connecting directly to a worker.

### Viewer

The Viewer supports:

- multiple Agent connections;
- native Windows credential persistence for saved Agent credentials;
- explicit connect/disconnect lifecycle;
- session selection and remote VNC viewing;
- view-only/control modes;
- mouse and keyboard input;
- bidirectional text clipboard bridging.

## Agent authentication

The Agent access token is currently stored as plaintext at:

```text
C:\ProgramData\MSM\agent\access-token
```

The installer restricts the Agent data directory to `SYSTEM` and `BUILTIN\Administrators`. The token must still be treated as a secret. The Viewer stores remembered credentials in the native Windows credential store rather than browser storage.

The Agent token is never reused as the VNC password. VNC access is granted through a short-lived, session-bound VNC ticket returned by the authenticated Agent control channel.

## Build

Requirements:

- Windows for the full Agent/worker path;
- Rust toolchain matching `rust-version` in the workspace;
- Bun;
- Tauri prerequisites for the desktop application.

Install frontend dependencies:

```powershell
bun install --frozen-lockfile
```

Build the workspace:

```powershell
cargo check --workspace
cargo test --workspace
bun run build
```

For the Windows Agent release binaries:

```powershell
cargo build --release -p msm-agent
```

## Local Agent testing

For a local non-service run:

```powershell
cargo run -p msm-agent -- --listen 127.0.0.1:40123
```

For LAN testing:

```powershell
cargo run -p msm-agent -- --listen 0.0.0.0:40123
```

Retrieve the persisted identity/token during controlled provisioning with:

```powershell
.\target\release\msm-agent.exe --print-identity
```

Because release builds use the Windows GUI subsystem, do not rely on console output. Read the provisioned token from:

```powershell
Get-Content C:\ProgramData\MSM\agent\access-token
```

Only perform that operation on the Agent machine and treat the result as a secret.

## Windows Agent installation

Build both Agent binaries and run the installer from an elevated PowerShell session:

```powershell
.\packaging\windows\install-agent.ps1 `
  -AgentBinaryPath .\target\release\msm-agent.exe `
  -WorkerBinaryPath .\target\release\msm-agent-worker.exe
```

The installer:

1. stops active workers;
2. stops and removes the previous `MSMAgent` service;
3. copies the Agent and worker binaries to `C:\Program Files\MSM`;
4. preserves existing identity/token state;
5. applies restrictive Agent data-directory ACLs;
6. installs `MSMAgent` as `LocalSystem`;
7. configures SCM recovery actions;
8. allows TCP/40123 on Domain/Private profiles;
9. blocks TCP/5901-5999 inbound;
10. starts the service and waits for `Running`.

The installation is intended to be safe to repeat for upgrades.

## Testing

The automated production gate covers:

- frontend frozen-lockfile installation and build;
- Rust formatting/check/test/Clippy;
- Windows Agent release compilation;
- Tauri packaging;
- Agent packaging.

The Agent worker supervisor also contains unit coverage for retry backoff and worker-port allocation.

Windows integration testing still needs to validate service lifecycle, multi-session behavior, worker crash recovery, clipboard, input, firewall behavior, upgrade/uninstall, and the 24-hour soak procedure. Use `docs/release-checklist.md` as the authoritative release gate.

## Security boundary

The current LAN build should be deployed only where the network path is trusted. Do not expose port `40123` to the public Internet.

Deferred hardening for an untrusted-network/Internet deployment includes:

- TLS/WSS Agent transport;
- DPAPI-backed Agent token storage;
- token rotation/revocation;
- certificate provisioning and SAN validation;
- bounded rotating service logs;
- stronger Internet-facing authorization and network policy.

See:

- `docs/architecture.md`
- `docs/production-hardening.md`
- `docs/release-checklist.md`
