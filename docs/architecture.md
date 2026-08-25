# MSM Architecture

## Scope

MSM currently targets Windows only. Linux and macOS are intentionally out of scope until a future product decision.

## Processes

MSM has two independent applications:

1. `msm` — operator desktop application built with Tauri, React, and noVNC.
2. `msm-agent` — headless Rust machine agent installed on managed Windows computers.

The agent also launches `msm-agent-worker` once for each remotely controlled Windows session.

## Device and multiseat model

```text
Device
└── Agent (LocalSystem)
    ├── Session 1 / Seat 1
    │   └── Worker (User A token) → VNC :5901
    ├── Session 2 / Seat 2
    │   └── Worker (User B token) → VNC :5902
    └── Session 3 / Seat 3
        └── Worker (User C token) → VNC :5903
```

A session is the durable remote-control target. VNC ports and worker process IDs are transient implementation details.

## Windows session lifecycle

The agent uses Windows Remote Desktop Services APIs to enumerate active sessions. When the viewer requests a session, the agent:

1. Validates the session ID.
2. Allocates a deterministic development VNC port for that session.
3. Obtains the logged-in user's session token with `WTSQueryUserToken`.
4. Starts `msm-agent-worker` with `CreateProcessAsUserW` and `winsta0\\default`.
5. The worker captures the target user's desktop with `xcap`.
6. The worker exposes the framebuffer through `rustvncserver`.
7. The worker translates RFB input events through `enigo` inside that same user session.
8. The agent proxies the VNC stream through its authenticated WebSocket endpoint.

This architecture is intended to prevent one user's desktop from being captured or controlled by another user's worker.

## Viewer responsibilities

The viewer owns operator interaction, device/session selection, noVNC rendering, connection state, and diagnostics. It does not need to be installed on managed computers.

## Local development transport

```text
Viewer
  │ authenticated WebSocket
  ├──────────────► Agent :40123
  │                    │
  │ startSession       ├──► Windows user session
  │                    │        └── Worker → VNC
  │                    │
  └──── WebSocket VNC proxy ◄───┘
```

The development agent currently exposes the control port directly. This is suitable for LAN testing only and is not a production Internet transport.

## VNC implementation

MSM uses `rustvncserver` rather than implementing RFB itself. The viewer uses the upstream noVNC client. OS capture and input are kept outside the VNC protocol implementation.

## Current limitations

- Primary-monitor capture only.
- Fixed 10 FPS capture loop for the initial implementation.
- Basic VNC keysym mapping.
- No clipboard or file transfer.
- Development bearer-token authentication only.
- The worker/VNC port is an internal endpoint and should be firewalled from remote hosts.
- No relay or TLS yet.

These are deliberate next-stage hardening items rather than reasons to duplicate existing upstream protocol libraries.
