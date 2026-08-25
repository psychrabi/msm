# MSM Architecture

## Scope

MSM currently targets Windows only. Linux and macOS are intentionally out of scope until a future product decision.

## Processes

MSM has two independent applications:

1. `msm` — operator desktop application built with Tauri, React, and noVNC.
2. `msm-agent` — headless Rust machine agent installed on managed Windows computers.

The agent also launches `msm-agent-worker` once for each remotely controlled Windows session. The agent service is the machine-level supervisor; workers are user-session processes.

```text
Windows machine
└── MSM Agent Service (LocalSystem)
    ├── Session 1 / Seat 1
    │   └── Worker (User A token) → VNC :5901
    ├── Session 2 / Seat 2
    │   └── Worker (User B token) → VNC :5902
    └── Session 3 / Seat 3
        └── Worker (User C token) → VNC :5903
```

A session is the durable remote-control target. VNC ports and worker process IDs are transient implementation details.

## Windows service lifecycle

The Windows service runs as `LocalSystem` and connects to the Windows Service Control Manager through the native service dispatcher. It is intended to remain alive independently of interactive user logons.

The service periodically reconciles the active Windows sessions with its worker set. For every active session it ensures that exactly one corresponding worker exists. This provides two important properties:

1. A worker is started when a user session becomes active.
2. If an existing worker is terminated or crashes while its session remains active, the service starts a replacement worker.

Workers are launched into the target user's interactive session using that user's Windows access token. Closing or killing a worker therefore does not terminate the machine service; the supervisor recreates it.

The worker should not be launched manually as a persistent console application in production. The service owns its lifecycle.

## Windows session lifecycle

The agent uses Windows Remote Desktop Services APIs to enumerate active sessions. During reconciliation, the agent:

1. Enumerates active interactive sessions.
2. Obtains the logged-in user's name and session ID.
3. Determines whether a worker for that session is already alive.
4. If the worker is missing, obtains the user's session token with `WTSQueryUserToken`.
5. Starts `msm-agent-worker` with `CreateProcessAsUserW` in `winsta0\\default`.
6. Tracks the worker process independently from the interactive user's console.
7. Repeats the reconciliation so terminated workers are restored.

When a session disappears, its worker is no longer required and its associated remote-session state can be released.

## Worker responsibilities

Each worker is isolated to one Windows session. It:

- captures the target user's desktop with `xcap`;
- exposes the framebuffer through `rustvncserver`;
- translates RFB keyboard and mouse events through `enigo` inside that same user session;
- bridges text clipboard changes between Windows and the VNC server; and
- listens on its session-specific VNC port.

This architecture is intended to prevent one user's desktop, input, or clipboard from being captured or controlled by another user's worker.

## Viewer responsibilities

The viewer owns operator interaction, device/session selection, noVNC rendering, connection state, persistent agent connections, credential retrieval, clipboard integration, and diagnostics. It does not need to be installed on managed computers.

### Monitoring layout

The monitoring page separates agent/session management from active remote viewers:

```text
┌─────────────────────────────────────────────────────────────┐
│ MSM Viewer       Monitoring   Settings   About     Status   │
├──────────────────┬──────────────────────────────────────────┤
│ Sessions          │ Remote viewers                           │
│                  │                                          │
│ User A [Connect] │ ┌────────────┐ ┌────────────┐            │
│ User B [Connect] │ │ User A VNC │ │ User B VNC │            │
│ User C [Connect] │ │            │ │            │            │
│                  │ └────────────┘ └────────────┘            │
└──────────────────┴──────────────────────────────────────────┘
```

Agent connection does not automatically open VNC viewers. Each session must be explicitly connected. Existing viewers are independent, so changing the selected session does not replace or reconnect another viewer.

### Persistent agent connections

The viewer persists the agent endpoint locally. When the operator enables **Remember**, the corresponding access token is stored through the Tauri native credential-store commands rather than browser/local storage.

Credentials are keyed by normalized agent endpoint, allowing multiple managed machines to have independent tokens. On startup the viewer retrieves the credential for the saved endpoint and can reconnect without prompting for the token again.

The viewer also supports:

- **Forget** — removes the saved endpoint and native credential.
- **401 handling** — removes the rejected saved credential and stops automatic retries until a new token is supplied.
- **Automatic agent reconnect** — retries a disconnected agent while the saved connection remains enabled.
- **Explicit remote-session connection** — a worker/VNC connection is only started when the operator selects a session.

The token itself is never intended to be persisted in `localStorage`.

### VNC clipboard integration

The worker bridges the Windows interactive-session clipboard to the VNC server. When the VNC client sends clipboard text, the worker writes it to the Windows clipboard. When the Windows clipboard changes, the worker publishes the text through the VNC server.

The viewer uses noVNC's clipboard API to:

- copy remote clipboard text to the operator clipboard when the Tauri webview permits clipboard access; and
- forward paste events to the remote VNC session when the viewer is in control mode.

The implementation is text-only at this stage; file/image clipboard formats are not transferred.

## Local development transport

```text
Viewer
  │ authenticated WebSocket
  ├──────────────► Agent Service :40123
  │                    │
  │ listSessions       ├──► Active Windows sessions
  │                    │
  │ startSession       ├──► User session
  │                    │        └── Worker → VNC
  │                    │
  └──── WebSocket VNC proxy ◄───┘
```

The development agent currently exposes the control port directly. This is suitable for LAN testing only and is not a production Internet transport.

## VNC implementation

MSM uses `rustvncserver` rather than implementing RFB itself. The viewer uses the upstream noVNC client. OS capture, clipboard, and input remain outside the VNC protocol implementation except for the VNC event bridge in the worker.

## Security and credential model

The agent currently uses a bearer access token for its authenticated WebSocket/control interface. The viewer stores remembered access tokens using the native Windows credential store through the Tauri backend.

The per-session VNC ports are internal implementation endpoints. They should not be exposed as a general remote-access interface; the agent's authenticated WebSocket proxy is the intended viewer path.

This remains a development-stage security model. Production deployment should add transport encryption, stronger credential provisioning/rotation, authorization policy, and appropriate network isolation.

## Current limitations / next stages

- Primary-monitor capture only.
- Fixed 10 FPS capture loop for the initial implementation.
- Basic VNC keysym mapping.
- Text clipboard only; no file/image transfer.
- Development bearer-token authentication only.
- The worker/VNC port is an internal endpoint and should be firewalled from remote hosts.
- No relay or TLS yet.
- Remote-session reconnect after worker replacement needs explicit viewer-side retry policy.
- Multi-agent management can be expanded from the current endpoint-oriented persistence model.

These are the next hardening stages rather than reasons to duplicate existing upstream protocol libraries.
