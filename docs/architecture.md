# MSM Architecture

## Scope

MSM currently targets Windows only.

## Processes

```text
Windows machine
└── MSM Agent Service (LocalSystem)
    ├── Session 1 / Seat 1
    │   └── Worker (User A token) → loopback VNC :5901
    ├── Session 2 / Seat 2
    │   └── Worker (User B token) → loopback VNC :5902
    └── Session 3 / Seat 3
        └── Worker (User C token) → loopback VNC :5903
```

The session ID is the durable remote-control target. VNC ports and worker PIDs are transient implementation details.

## Transport

The current release uses authenticated plain WebSocket on the trusted LAN:

```text
Viewer
  │
  │ WS + Bearer Agent token
  ▼
MSM Agent :40123
  │
  │ short-lived session ticket
  ▼
WS VNC proxy
  │
  │ loopback TCP only
  ▼
Worker VNC :590x
```

The long-lived Agent token is never placed in the VNC URL. A random session-bound VNC ticket is issued over the authenticated control WebSocket and expires after five minutes.

`ws://` is the active transport for this release. It is a trusted-LAN boundary, not an Internet security boundary.

## Credential model

- Agent tokens are generated independently from VNC passwords.
- The Agent token is currently stored as plaintext in `C:\ProgramData\MSM\agent\access-token`.
- The Agent data directory is ACL-restricted to LocalSystem and Administrators by the installer.
- Each worker receives a random VNC password.
- VNC access is additionally gated by a short-lived, session-bound ticket.

The repository contains a DPAPI implementation as deferred hardening work; it is not used by the active token-storage path.

## Windows service lifecycle

The Windows service is the machine-level supervisor. It runs independently of interactive user sessions and periodically reconciles active sessions with its worker registry.

For each eligible interactive session it ensures exactly one worker exists. If a worker exits while its session remains active, the supervisor respawns it. Worker start failures use bounded exponential backoff up to 60 seconds to prevent tight process-spawn loops.

When a session disappears, its worker is terminated and the worker state is removed.

## Worker responsibilities

Each worker is isolated to one Windows session. It:

- captures the target user's desktop with `xcap`;
- exposes the framebuffer through `rustvncserver`;
- translates RFB keyboard/mouse events through `enigo`;
- bridges text clipboard changes; and
- listens on its assigned loopback VNC port.

The installer blocks inbound access to TCP `5901-5999`, so the Agent proxy is the intended VNC access path.

## Viewer responsibilities

The Viewer owns device/session selection, noVNC rendering, connection state, persistent Agent connections, credential retrieval, clipboard integration, and operator controls. Agent connections and individual VNC viewers remain independently managed.

The default viewer mode is View only. Control mode is explicit.

## Service recovery

The Windows installer configures SCM recovery actions:

- first failure: restart after 5 seconds;
- second failure: restart after 15 seconds;
- third failure: restart after 60 seconds;
- reset failure counter after 24 hours.

This is separate from the Agent's per-worker watchdog recovery.

## Local development

A developer can run the Agent without the Windows service on loopback or a controlled LAN test address:

```powershell
cargo run -p msm-agent -- --listen 127.0.0.1:40123
```

For LAN testing, bind explicitly to the machine's LAN interface or `0.0.0.0:40123` and keep the network trusted.

## Current limitations and deferred hardening

- primary-monitor capture only;
- fixed initial capture cadence;
- basic keysym mapping;
- text clipboard only;
- monitor hotplug and display topology need broader soak testing;
- production logging sink and retention still depend on deployment configuration;
- Windows code signing and final release artifact verification are release-gate responsibilities;
- TLS/WSS transport is not yet implemented in the active release;
- DPAPI-backed Agent token storage is not yet enabled;
- token rotation/revocation is not yet implemented.

See `docs/production-hardening.md` and `docs/release-checklist.md` for operational and release requirements.
