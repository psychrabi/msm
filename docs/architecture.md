# MSM Architecture

## Scope

MSM currently targets Windows only.

## Processes

```text
Windows machine
└── MSM Agent Service (LocalSystem)
    ├── Session 1 / Seat 1
    │   ├── Monitor 0 worker → loopback VNC :5901
    │   └── Monitor 1 worker → loopback VNC :5902
    └── Session 2 / Seat 2
        └── Monitor 0 worker → loopback VNC :5903
```

The durable remote-view identity is the pair `(session_id, monitor_index)`. VNC ports and worker PIDs are transient implementation details.

## Transport

The current release uses authenticated plain WebSocket on the trusted LAN:

```text
Viewer
  │
  │ WS + Bearer Agent token
  ▼
MSM Agent :40123
  │
  │ short-lived session/monitor ticket
  ▼
WS VNC proxy /vnc/<session>/<monitor>
  │
  │ loopback TCP only
  ▼
Worker VNC :590x
```

The long-lived Agent token is never placed in the VNC URL. A random session/monitor-bound VNC ticket is issued over the authenticated control WebSocket and expires after five minutes.

`ws://` is the active transport for this release. It is a trusted-LAN boundary, not an Internet security boundary.

## Credential model

- Agent tokens are generated independently from VNC passwords.
- The Agent token is stored as plaintext in `C:\ProgramData\MSM\agent\access-token`.
- Sensitive token/identity files remain restricted to LocalSystem and Administrators.
- Session workers may publish non-secret `monitors-<session>.json` metadata used by the Agent/Viewer.
- Each worker receives a random VNC password.
- VNC access is additionally gated by a short-lived session/monitor-bound ticket.

DPAPI-backed token storage remains deferred hardening work.

## Windows service lifecycle

The LocalSystem service periodically reconciles active Windows sessions with its worker registry. One primary-monitor worker is kept warm for each active session. Additional monitor workers are started on demand and remain alive while the session exists, allowing multiple monitors to be viewed simultaneously.

Worker start failures use bounded backoff up to 60 seconds. When a session disappears, all workers for that session are terminated and removed.

## Monitor discovery and selection

Workers enumerate displays with `xcap`. Monitor metadata contains a stable index for the current topology plus name, width, height, virtual-desktop `x`/`y`, and `isPrimary`. Monitor index 0 is normalized to the primary display; subsequent indexes represent the other detected displays.

Each capture worker targets exactly one monitor. Mouse coordinates received through VNC are monitor-relative and are translated by the worker to Windows virtual-desktop coordinates using that monitor's `x`/`y` origin.

## Worker responsibilities

Each worker:

- runs in the target user's Windows session;
- captures one selected monitor with `xcap`;
- exposes the framebuffer through `rustvncserver`;
- translates RFB keyboard/mouse events through `enigo`;
- bridges text clipboard changes;
- publishes current monitor metadata; and
- listens on its assigned loopback VNC port.

The installer blocks inbound access to TCP `5901-5999`, so the Agent proxy is the intended remote path.

## Viewer responsibilities

The Viewer owns Agent/session selection, monitor topology, noVNC rendering, connection state, credential retrieval, clipboard integration, and operator controls. Multiple monitor streams for one session are grouped into one viewer card while their VNC connections remain independent.

The normal viewer is view-only. Fullscreen provides an explicit view-only/control toggle.

## Service recovery

The Windows installer configures SCM recovery actions: restart after 5 seconds, 15 seconds, and 60 seconds for the first three failures, with the failure counter reset after 24 hours.

## Local development

```powershell
cargo run -p msm-agent -- --listen 127.0.0.1:40123
```

For LAN testing, bind explicitly to a trusted interface or `0.0.0.0:40123`.

## Current limitations and deferred hardening

- combined Viewer currently groups monitors but exact physical/topology layout reproduction is still being refined;
- monitor hotplug/resolution changes require broader soak testing;
- fixed initial capture cadence;
- basic keysym mapping;
- text clipboard only;
- production logging sink/retention depends on deployment configuration;
- Windows signing and final artifact verification remain release gates;
- TLS/WSS is deferred for trusted-LAN deployment;
- DPAPI-backed Agent token storage is deferred;
- token rotation/revocation is not implemented.

See `docs/production-hardening.md` and `docs/release-checklist.md` for operational and release requirements.
