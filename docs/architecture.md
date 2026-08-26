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

Production service mode uses native rustls TLS:

```text
Viewer
  │
  │ WSS + Bearer Agent token
  ▼
MSM Agent :40123
  │
  │ short-lived session ticket
  ▼
WSS VNC proxy
  │
  │ loopback TCP only
  ▼
Worker VNC :590x
```

The long-lived Agent token is never placed in the VNC URL. A random session-bound VNC ticket is issued over the authenticated control WebSocket and expires after five minutes.

Direct `ws://` operation is development-only. The Viewer defaults to `wss://`, and the VNC viewer rejects non-TLS endpoints.

## Credential model

- Agent tokens are generated independently from VNC passwords.
- Agent tokens are stored with Windows DPAPI machine protection.
- The Agent data directory is ACL-restricted to LocalSystem and Administrators by the installer.
- Legacy plaintext token files are migrated to DPAPI storage on startup.
- Each worker receives a random VNC password.
- VNC access is additionally gated by a short-lived, session-bound ticket.

DPAPI machine scope and the directory ACL are defense-in-depth and do not protect against a compromised SYSTEM account.

## Windows service lifecycle

The Windows service is the machine-level supervisor. It runs independently of interactive user sessions and periodically reconciles active sessions with its worker registry.

For each eligible interactive session it ensures exactly one worker exists. If a worker exits while its session remains active, the supervisor respawns it. Worker start failures use bounded exponential-style backoff up to 60 seconds to prevent tight process-spawn loops.

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

The viewer owns device/session selection, noVNC rendering, connection state, persistent Agent connections, credential retrieval, clipboard integration, and operator controls. Agent connections and individual VNC viewers remain independently managed.

The default viewer mode is View only. Control mode is explicit.

## Service recovery

The Windows installer configures SCM recovery actions:

- first failure: restart after 5 seconds;
- second failure: restart after 15 seconds;
- third failure: restart after 60 seconds;
- reset failure counter after 24 hours.

This is separate from the Agent's per-worker watchdog recovery.

## TLS assets

Production service installation expects:

```text
C:\ProgramData\MSM\agent\tls\cert.pem
C:\ProgramData\MSM\agent\tls\key.pem
```

The private key is provisioned out-of-band and is never generated or committed by the repository. The service is installed with explicit `--tls-cert` and `--tls-key` arguments.

## Local development

A developer can run the Agent without TLS on loopback or a controlled LAN test address. This mode is intentionally not the production network boundary.

## Remaining product limitations

- primary-monitor capture only;
- fixed initial capture cadence;
- basic keysym mapping;
- text clipboard only;
- monitor hotplug and display topology need broader soak testing;
- production logging sink and retention still depend on deployment configuration;
- Windows code signing and final release artifact verification are release-gate responsibilities.

See `docs/production-hardening.md` and `docs/release-checklist.md` for operational and release requirements.
