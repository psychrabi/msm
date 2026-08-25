# Architecture

## Principles

1. A physical device and a user desktop session are separate resources.
2. A session is the durable identity for remote control; VNC ports are ephemeral implementation details.
3. The machine agent is headless and independent of the interactive Tauri application.
4. OS-specific session discovery, desktop capture/input, and process management are isolated behind platform adapters.
5. Prefer established Tauri plugins and mature Rust crates wherever practical.

## Initial repository layout

```text
msm/
├── apps/
│   └── desktop/       # Tauri desktop application
├── crates/
│   ├── core/          # shared domain types and orchestration boundaries
│   ├── rfb/           # RFB/VNC protocol integration boundary
│   └── agent/         # machine-agent application boundary
├── docs/
│   └── architecture.md
├── Cargo.toml
├── package.json
└── README.md
```

The boundaries above are intentionally thin. They are not intended to replace mature upstream crates. When an established crate already provides a capability, MSM should use it directly rather than creating a parallel internal implementation.

## Multiseat target model

```text
Device
└── SessionManager
    ├── Session A -> VNC endpoint A
    ├── Session B -> VNC endpoint B
    └── Session C -> VNC endpoint C
```

The session manager owns lifecycle and routing. A per-session VNC server may bind to a distinct local TCP port, Unix socket, named pipe, or platform-equivalent endpoint. The public API refers to the session ID, never the port.

## Future transport

The design should keep RFB/VNC behind a transport boundary so the management/session model can later support another remote-desktop transport without being rewritten.
