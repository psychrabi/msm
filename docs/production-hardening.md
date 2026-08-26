# MSM Production Hardening

## Security model

The MSM Agent exposes an authenticated control WebSocket and a VNC WebSocket proxy. Production service mode now requires native TLS using a PEM certificate and private key stored under:

- `C:\ProgramData\MSM\agent\tls\cert.pem`
- `C:\ProgramData\MSM\agent\tls\key.pem`

The Windows service is installed with `--tls-cert` and `--tls-key` arguments and will not install without both files.

The Viewer defaults to `wss://` for agent endpoints. Explicit `ws://` endpoints are development-only and are not accepted by the VNC viewer.

### Credentials

- The Agent authentication token is generated independently of VNC credentials.
- The token is stored using Windows DPAPI machine protection and the data directory is ACL-restricted to LocalSystem and Administrators.
- Existing legacy plaintext tokens are migrated to DPAPI storage on first startup.
- Each worker receives a random VNC password.
- Viewer-to-VNC authorization uses a short-lived, session-bound VNC ticket rather than the long-lived Agent token.

A local administrator or SYSTEM account is still a trusted principal. DPAPI machine scope and the directory ACL are defense-in-depth, not a protection boundary against SYSTEM compromise.

## Worker lifecycle

The Windows service owns one worker registry and reconciles it against interactive Windows sessions.

Worker failures use bounded retry backoff rather than an unbounded three-second spawn loop. Successful workers clear the failure state.

Workers must remain loopback-only. The installer installs a firewall block for TCP ports `5901-5999`; VNC traffic is expected to reach the worker only through the authenticated Agent proxy.

## Service recovery

The installer configures Windows SCM recovery actions:

1. first failure: restart after 5 seconds
2. second failure: restart after 15 seconds
3. third failure: restart after 60 seconds
4. failure counter reset: 24 hours

## TLS certificate requirements

Use a certificate whose SAN covers the hostname used by the Viewer. For production deployments, use a certificate issued by the organization's trusted CA or a publicly trusted CA where appropriate.

The private key must be readable by the LocalSystem service account and must not be distributed in source control.

For a first installation:

```powershell
.\install-agent.ps1 `
  -TlsCertificatePath C:\secure\msm-agent-cert.pem `
  -TlsPrivateKeyPath C:\secure\msm-agent-key.pem
```

Subsequent upgrades preserve the installed TLS assets when certificate parameters are omitted.

## Upgrade/uninstall behavior

The installer:

1. stops existing workers;
2. stops the Windows service and waits for SCM state convergence;
3. deletes the old service and waits for disappearance;
4. replaces the binaries;
5. preserves or replaces TLS assets;
6. reapplies restrictive ACLs;
7. reinstalls the service with TLS arguments;
8. reapplies service recovery and firewall rules;
9. starts the service and waits for `Running`.

## Logging

Service-mode logging must be captured by the deployment environment before release. The current Agent uses structured `tracing` output; a production deployment should route service and worker output to a retained log sink or Windows Event Log before broad rollout.

## Release validation

Do not mark a release production-ready until the checklist in `docs/release-checklist.md` is complete and the Windows CI job has produced successful release binaries and installers.
