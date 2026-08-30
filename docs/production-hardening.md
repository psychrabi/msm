# MSM Production Hardening

## Current transport and credential model

The current Agent deployment target is a trusted school/LAN environment and uses authenticated plain WebSocket transport:

- control endpoint: `ws://<agent-host>:40123/ws`
- health endpoint: `http://<agent-host>:40123/health`
- VNC proxy endpoint: `ws://<agent-host>:40123/vnc/<session-id>?ticket=<ticket>`
- internal worker/VNC ports: `127.0.0.1:5901-5999`

This is intentionally **not an Internet-safe transport**. Agent credentials and VNC traffic are exposed to anyone able to observe the LAN path. Do not expose TCP/40123 outside a trusted network boundary.

The Agent access token is currently stored as plaintext in:

```text
C:\ProgramData\MSM\agent\access-token
```

The Windows installer restricts the Agent data directory to `SYSTEM` and `BUILTIN\Administrators`. This reduces local exposure but does not protect the token from a local administrator or SYSTEM compromise.

The `agent/src/dpapi.rs` implementation is retained as deferred hardening work and is not part of the active token-storage path.

## Credential separation

- The Agent authentication token is independent of VNC credentials.
- Each worker receives a random VNC password.
- Viewer-to-VNC authorization uses a short-lived, session-bound VNC ticket rather than the long-lived Agent token.
- Authentication failures return `401 Unauthorized` without returning the expected credential.
- Tokens and VNC passwords must never be written to tracing logs.

## Worker lifecycle

The Windows service owns one worker registry and reconciles it against interactive Windows sessions.

Worker failures use bounded retry backoff rather than an unbounded three-second spawn loop. Successful workers clear the failure state.

Workers must remain loopback-only. The installer also installs a firewall block for TCP ports `5901-5999`; VNC traffic is expected to reach the worker only through the authenticated Agent proxy.

## Service recovery

The installer configures Windows SCM recovery actions:

1. first failure: restart after 5 seconds;
2. second failure: restart after 15 seconds;
3. third failure: restart after 60 seconds;
4. failure counter reset: 24 hours.

## Upgrade/uninstall behavior

The installer:

1. stops existing workers;
2. stops the Windows service and waits for SCM state convergence;
3. deletes the old service and waits for disappearance;
4. replaces the Agent and worker binaries;
5. preserves the existing identity and access-token files;
6. reapplies restrictive data-directory ACLs;
7. reinstalls the service;
8. reapplies service recovery and firewall rules;
9. starts the service and waits for `Running`.

The installer is deliberately idempotent: reinstalling the same binaries does not rotate the device identity or access token.

## Observability

Release builds hide the Agent and worker console windows, so service operation must not depend on console output. The installer creates:

```text
C:\ProgramData\MSM\agent\logs
```

Structured `tracing` is already present in the Agent and worker. A deployment should route service/worker output to a retained sink or Windows Event Log before broad rollout; this remains an operational hardening item.

## Automated gates

GitHub Actions validates:

- frontend frozen-lockfile installation and production build;
- Rust formatting, workspace check, tests, and Clippy;
- Windows Agent release compilation;
- Tauri application packaging;
- Agent packaging.

The worker supervisor now has unit coverage for retry backoff and VNC port allocation. Windows-only lifecycle behavior still requires the Windows integration matrix described in the release checklist.

## Deferred security hardening

The following remain intentionally deferred while the LAN `ws://` deployment is the active product target:

- native TLS/WSS for Agent transport;
- DPAPI-backed Agent token storage;
- certificate provisioning/rotation;
- certificate SAN validation;
- cryptographic token rotation/revocation;
- Windows Event Log or bounded rotating service logs.

These items are release blockers for an Internet-facing or untrusted-network deployment, but not prerequisites for the current trusted-LAN milestone.
