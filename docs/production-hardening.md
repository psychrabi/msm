# MSM Production Hardening

## Current transport and credential model

The current Agent deployment target is a trusted private-LAN environment and uses authenticated plain WebSocket transport:

- control endpoint: `ws://<agent-host>:40123/ws`
- health endpoint: `http://<agent-host>:40123/health`
- VNC proxy endpoint: `ws://<agent-host>:40123/vnc/<session-id>/<monitor-index>?ticket=<ticket>`
- internal worker/VNC ports: `127.0.0.1:5901-5999`

This is intentionally **not an Internet-safe transport**. Do not expose TCP/40123 outside a trusted network boundary.

The Agent access token is stored as plaintext in:

```text
C:\ProgramData\MSM\agent\access-token
```

Sensitive identity/token files are restricted to `SYSTEM` and `BUILTIN\Administrators`. Session workers are permitted to publish non-secret monitor inventory metadata used by the Agent/Viewer.

DPAPI-backed token storage remains deferred hardening work and is not part of the active token-storage path.

## Credential separation

- The Agent authentication token is independent from worker VNC credentials.
- Each worker receives a random VNC password.
- Viewer-to-VNC authorization uses a short-lived ticket bound to the requested session and monitor.
- Authentication failures return `401 Unauthorized` without returning the expected credential.
- Agent tokens, VNC passwords, and VNC tickets must never be written to logs.

## Worker lifecycle

The Windows service owns a worker registry keyed by `(session_id, monitor_index)` and reconciles it against interactive Windows sessions. It keeps a primary-display worker warm and starts additional monitor workers on demand.

Worker failures use bounded retry backoff rather than an unbounded spawn loop. Successful workers clear failure state. All workers for a session are removed when that session disappears.

Workers remain loopback-only. The installer also blocks inbound TCP `5901-5999`, so VNC traffic reaches workers only through the authenticated Agent proxy.

## Monitor metadata

Workers publish `monitors-<session>.json` containing monitor index, name, resolution, virtual-desktop position, and primary-display state. This metadata is not a credential. Keep sensitive token/identity ACLs separate from the permission required for session workers to refresh monitor metadata.

## Service recovery

The installer configures Windows SCM recovery actions:

1. first failure: restart after 5 seconds;
2. second failure: restart after 15 seconds;
3. third failure: restart after 60 seconds;
4. failure counter reset: 24 hours.

## Upgrade/uninstall behavior

The installer stops active workers and the service, waits for SCM convergence, removes the previous service registration, replaces the Agent/worker binaries, preserves identity/token state, reapplies ACL/firewall/recovery configuration, reinstalls the service, starts it, and waits for `Running`.

The installer is intended to be idempotent and does not rotate identity or the Agent access token during a normal reinstall/upgrade.

## Observability

Release builds hide Agent and worker console windows. Structured `tracing` is present, but broad deployment should still route service/worker output to a retained sink or Windows Event Log. Never log credentials or tickets.

## Automated gates

GitHub Actions validates frontend dependency installation/build, Rust formatting/check/test/Clippy, Windows Agent release compilation, Tauri packaging, and Agent packaging. Unit coverage includes supervisor retry/backoff and worker-port allocation across monitors.

Windows-only lifecycle and multi-monitor behavior still require the physical validation matrix in `docs/release-validation.md`.

## Deferred security hardening

The following remain deferred while trusted-LAN `ws://` is the active product target:

- native TLS/WSS for Agent transport;
- DPAPI-backed Agent token storage;
- token rotation/revocation;
- certificate provisioning/rotation and SAN validation;
- bounded rotating service logs;
- Internet-facing authorization/network policy.

These are blockers for an Internet-facing or otherwise untrusted-network deployment, but not for the current trusted-LAN milestone.
