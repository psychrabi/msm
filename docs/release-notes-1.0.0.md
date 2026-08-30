# MSM 1.0.0 — Trusted-LAN Release Notes

## Release scope

MSM 1.0.0 provides Windows multiseat remote viewing through a Tauri Viewer, a LocalSystem Agent service, and one VNC worker per eligible interactive Windows session.

This release is intended for **trusted private LAN deployments**.

## Included

- Windows Agent service installation and lifecycle management.
- Automatic service recovery through Windows SCM.
- Per-session worker creation and cleanup.
- Bounded worker retry/backoff after failures.
- Session-scoped random VNC passwords.
- Five-minute session-bound VNC tickets.
- Authenticated Agent health/control endpoints.
- WebSocket VNC proxying to loopback-only workers.
- Viewer support for multiple Agents and independently managed sessions.
- Native Viewer credential persistence.
- Remote mouse and keyboard control with explicit control mode.
- Bidirectional text clipboard bridging.
- Installer firewall policy for Agent/VNC ports.
- Restrictive Agent data-directory ACLs.
- Automated frontend/Rust/Windows build gates.
- Worker-supervisor unit coverage for retry and port allocation.

## Transport

The active Agent transport is:

```text
ws://<agent-host>:40123/ws
```

The Agent token is currently stored as plaintext at:

```text
C:\ProgramData\MSM\agent\access-token
```

These choices are deliberate for the current LAN deployment and are not suitable for an untrusted network.

## Upgrade behavior

The Windows Agent installer stops active workers and the existing service, waits for SCM convergence, replaces the binaries, preserves the existing identity/token state, reapplies ACL/firewall/recovery configuration, reinstalls the service, and waits for `Running`.

## Deferred hardening

The following are explicitly deferred beyond the current LAN milestone:

- TLS/WSS Agent transport;
- DPAPI-backed Agent token storage;
- token rotation/revocation;
- certificate provisioning/SAN validation;
- bounded rotating Agent/service logs;
- Internet-facing authorization and network policy.

## Release gate

The authoritative operational gate is `docs/release-checklist.md`. A 1.0.0 build must not be exposed to the public Internet merely because the application and service installation succeed.
