# MSM

MSM is a VNC-based remote monitor and control application designed for multiseat workstations.

## Current direction

- Rust for the core/agent and native integrations.
- Tauri for the desktop application shell.
- React + TypeScript for the UI.
- PostgreSQL for server-side persistence when the management backend is introduced.
- No CI/CD yet; local development and Git-based pulls are the current workflow.
- Prefer established Tauri plugins and mature Rust crates over custom infrastructure.

## Multiseat model

A physical device can contain multiple independent user sessions. Each session is a first-class remote-control target and may have its own VNC server endpoint.

```text
Device
├── Seat 1
│   └── Session A
│       └── VNC server
├── Seat 2
│   └── Session B
│       └── VNC server
└── Seat 3
    └── Session C
        └── VNC server
```

Session identity must not depend on a VNC TCP port. Ports/sockets are implementation details managed by the machine agent.

## Development

The initial repository intentionally contains only the application foundation. Platform-specific multiseat session discovery and VNC process/session management will be added behind OS-specific adapters.

CI/CD is intentionally not configured at this stage.
