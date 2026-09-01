# MSM 1.0.0 — Trusted-LAN Release Notes

## Release scope

MSM 1.0.0 provides Windows multiseat remote viewing/control through a Tauri Viewer, a LocalSystem Agent service, and per-session/per-monitor VNC workers. This release is intended for **trusted private LAN deployments**.

## Included

- Windows Agent service installation and SCM recovery.
- Persistent Agent identity and plaintext LAN access token.
- Authenticated health/control endpoints.
- Per-session worker supervision with bounded retry/backoff.
- Multi-monitor discovery and monitor-specific workers.
- Session + monitor keyed VNC routing/tickets.
- Combined Viewer card for all monitors in a Windows session.
- Independent per-monitor connect/disconnect state.
- Remote mouse/keyboard control with monitor-origin translation.
- Bidirectional text clipboard bridging.
- Multiple Agent support in the Viewer.
- Installer firewall policy for Agent/VNC ports.
- Split ACL model protecting sensitive Agent state while permitting monitor metadata publication.
- Automated frontend/Rust/Windows build gates and supervisor unit coverage.

## Transport

The active Agent transport is:

```text
ws://<agent-host>:40123/ws
```

The Agent token is stored as plaintext at:

```text
C:\ProgramData\MSM\agent\access-token
```

These choices are deliberate for the current trusted-LAN deployment and are not suitable for an untrusted network.

## Upgrade behavior

The Windows Agent installer stops active workers and the existing service, waits for SCM convergence, replaces the binaries, preserves identity/token state, reapplies ACL/firewall/recovery configuration, reinstalls the service, and waits for `Running`.

## Deferred hardening

Deferred beyond this LAN milestone: TLS/WSS Agent transport, DPAPI-backed Agent token storage, token rotation/revocation, certificate provisioning/SAN validation, bounded rotating service logs, and Internet-facing authorization/network policy.

## Release gate

Use `docs/release-checklist.md` and `docs/release-validation.md` as the operational gate. A successful build/install does not make this release safe for public-Internet exposure.
