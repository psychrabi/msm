# MSM Architecture

## Processes

MSM has two independent executables:

1. `msm` — operator desktop application built with Tauri and React.
2. `msm-agent` — headless Rust service installed on managed computers.

The viewer must never be required to run on a managed computer.

## Device and session model

```text
Device
├── Seat
│   └── Session
│       └── VNC endpoint
└── Seat
    └── Session
        └── VNC endpoint
```

A session is the durable remote-control target. VNC ports, Unix sockets, named pipes, and process IDs are transient implementation details.

## Agent responsibilities

The machine agent owns:

- Device identity.
- Device authentication credentials.
- OS session discovery.
- Seat/session mapping.
- Per-session VNC process lifecycle.
- Per-session screen capture and input routing.
- Local policy enforcement.
- Relay connectivity when the management service is introduced.

The agent must continue operating when no interactive viewer is running.

## Viewer responsibilities

The viewer owns:

- Operator authentication.
- Device/session browsing.
- Remote session selection.
- VNC rendering and operator input.
- Connection state and diagnostics.

It should not inspect or control the local machine's OS sessions as part of normal remote operation.

## Transport layers

The intended production path is:

```text
Viewer
  │
  │ authenticated secure session
  ▼
Relay
  │
  │ authenticated secure session
  ▼
Agent
  │
  │ local IPC/socket
  ▼
Per-session VNC server
```

The relay should remain VNC-agnostic. It routes an authenticated session without interpreting RFB framebuffer or input messages.

For local development, the agent currently exposes an authenticated WebSocket control endpoint directly. This is intentionally not a production Internet transport.

## VNC implementation

Do not implement RFB from scratch unless the existing Rust ecosystem proves insufficient. `rustvncserver` is the current candidate for the server-side RFB implementation, while noVNC is the current candidate for the desktop viewer's VNC client.

The VNC layer must be separated from OS capture/input. A VNC server instance receives framebuffer updates from the capture layer and input events are routed through the session-specific input layer.

## Multiseat isolation

For every session:

- Capture must originate from that session's desktop.
- Input must be injected into that session only.
- Clipboard and file-transfer capabilities must be independently authorized.
- A session process must not receive another user's desktop or input events.

The machine-level agent may have elevated privileges, but per-session workers should run with the least privilege supported by the target OS.

## Security boundary

Development pairing currently uses a locally persisted bearer token. Production pairing should move to device keys/certificates and short-lived operator session credentials. The production agent connection should be outbound and authenticated, with no exposed VNC listener.
