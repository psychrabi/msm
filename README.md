# MSM

MSM is a VNC-based remote monitor and control application designed for multiseat workstations.

## Current stack

- Rust for the application core, machine agent, VNC/RFB work, and native OS integration.
- Tauri 2 for the desktop application shell.
- React + TypeScript + Vite for the UI.
- PostgreSQL for server-side persistence when the management backend is introduced.
- No CI/CD yet; local development and Git-based pulls are the current workflow.
- Prefer established Tauri plugins and mature Rust crates over custom infrastructure.

Tauri currently recommends Vite for SPA frameworks such as React, and the official project generator supports React + TypeScript. See the official Tauri documentation for prerequisites and local development.

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

## Current implementation

The repository now contains a minimal buildable Tauri application foundation with:

- React/TypeScript desktop UI.
- Tauri Rust backend.
- Tauri logging, OS, and process plugins.
- A native `app_info` command exposed to the frontend.
- A `list_sessions` command boundary that intentionally returns no sessions until an OS-specific provider is implemented.
- A multiseat-oriented UI that consumes the native session command instead of fabricating local users.

Session discovery is deliberately not mocked. The next implementation step is an OS-specific provider for the first supported operating system, followed by per-session VNC process lifecycle management.

## Local development

```bash
npm install
npm run tauri dev
```

For Tauri prerequisites, use the official documentation: https://v2.tauri.app/start/prerequisites/

CI/CD is intentionally not configured at this stage.
