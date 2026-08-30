# MSM Trusted-LAN Release Checklist

This checklist describes the current release target: a Windows Agent and Viewer communicating over authenticated plain WebSocket on a trusted private LAN. It does **not** authorize Internet exposure.

## 1. Source and version

- [ ] Release version is identical in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `agent/Cargo.toml`.
- [ ] `Cargo.lock` is synchronized with workspace manifests.
- [ ] `bun.lock` is current.
- [ ] No access tokens, VNC passwords, certificates, private keys, or local credentials are committed.
- [ ] Release notes describe the LAN-only `ws://` transport and credential model.

## 2. CI gates

- [ ] `bun install --frozen-lockfile` succeeds.
- [ ] `bun run build` succeeds.
- [ ] `cargo fmt --all -- --check` succeeds.
- [ ] `cargo check --workspace` succeeds.
- [ ] `cargo test --workspace` succeeds.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` succeeds.
- [ ] Windows `cargo build --release -p msm-agent` succeeds.
- [ ] Tauri installer build succeeds.
- [ ] Windows Agent packaging succeeds.

## 3. Current security boundary

- [ ] Agent transport is documented as `ws://`/HTTP and is restricted to a trusted private LAN.
- [ ] TCP/40123 is not exposed through the public Internet.
- [ ] Agent data directory ACL permits only `SYSTEM` and `BUILTIN\Administrators`.
- [ ] Agent access token is persisted in `C:\ProgramData\MSM\agent\access-token`.
- [ ] Viewer stores the Agent token only in its native credential store when **Remember** is enabled.
- [ ] VNC password is independent from the Agent token.
- [ ] VNC ticket is short-lived and session-bound.
- [ ] Worker/VNC ports `5901-5999` are loopback-only and blocked inbound by the installer firewall rule.
- [ ] Invalid Agent credentials return `401` without disclosing the expected token.
- [ ] Logs do not contain Agent tokens or VNC passwords.

## 4. Windows service

- [ ] Fresh installation succeeds on a clean Windows machine.
- [ ] Upgrade succeeds while workers are active.
- [ ] Service reaches `Running` after installation.
- [ ] Service starts automatically after reboot.
- [ ] Service recovery restarts the Agent after process failure.
- [ ] Service stop leaves no worker processes behind.
- [ ] Service uninstall removes the SCM entry after DELETE_PENDING convergence.
- [ ] Reinstall leaves no stale worker processes or listeners.
- [ ] `--print-identity` remains usable as a controlled provisioning/debug command even though release builds have no console window.

## 5. Session and worker lifecycle

- [ ] One worker is created per eligible interactive session.
- [ ] Duplicate concurrent `StartSession` requests do not create duplicate workers.
- [ ] Worker crash causes recovery.
- [ ] Repeated worker failure backs off and does not create a tight spawn loop.
- [ ] Session disappearance terminates its worker.
- [ ] Worker port exhaustion returns a controlled error.
- [ ] Worker binds only to loopback.
- [ ] Multiple users/sessions work simultaneously.
- [ ] Lock/unlock and disconnect/reconnect behavior is validated.
- [ ] Monitor hotplug/resolution changes do not permanently kill capture.

## 6. Viewer

- [ ] Multiple Agents can be connected simultaneously.
- [ ] Agent reconnect works after a temporary network outage.
- [ ] Manual Viewer disconnect remains intentional and does not auto-reconnect.
- [ ] Agent removal clears its saved credential.
- [ ] `401`, timeout, and protocol errors have useful user-facing messages.
- [ ] Remote mouse input works.
- [ ] Remote keyboard input works, including modifiers and function keys.
- [ ] View-only mode is enforced.
- [ ] Fullscreen controls do not interfere with remote interaction.
- [ ] VNC disconnect cleans up Viewer state.

## 7. Clipboard

- [ ] Windows-to-Viewer text clipboard works.
- [ ] Viewer-to-Windows text clipboard works.
- [ ] Unicode text is preserved.
- [ ] Clipboard feedback loops are impossible.
- [ ] Large clipboard payloads are bounded or rejected safely.
- [ ] Clipboard failures do not kill the worker.
- [ ] Locked/disconnected sessions are handled cleanly.

## 8. Packaging and upgrade

- [ ] Application installer installs cleanly.
- [ ] Application installer uninstalls cleanly.
- [ ] Agent package contains both release binaries and `packaging/windows/install-agent.ps1`.
- [ ] Installer version matches Agent version.
- [ ] Upgrade preserves the existing identity and access token.
- [ ] Uninstall removes service/binaries without deleting externally managed operator data unexpectedly.
- [ ] Installer is idempotent and succeeds on a second run.

## 9. Observability

- [ ] Agent startup/shutdown is observable through structured tracing.
- [ ] Worker PID/session lifecycle is logged.
- [ ] Worker crash/retry/backoff is logged.
- [ ] Authentication failures are logged without credentials.
- [ ] Service logs are captured by the deployment environment.
- [ ] Operators know where to retrieve logs from a failed endpoint.

## 10. Release-candidate soak test

Run the release candidate continuously for at least 24 hours on a representative Windows host with multiple interactive sessions.

- [ ] Reboot recovery passed.
- [ ] User login/logout passed.
- [ ] Session disconnect/reconnect passed.
- [ ] Worker crash recovery passed.
- [ ] Network outage/recovery passed.
- [ ] Viewer restart/recovery passed.
- [ ] No unbounded process growth.
- [ ] No memory/resource leak observed.
- [ ] No credential leakage observed.

## 11. Final sign-off

- [ ] All P0/P1 findings are closed.
- [ ] CI is green for the exact release commit.
- [ ] Windows installer has been tested on a clean machine.
- [ ] Release artifacts are checksummed and archived.
- [ ] Windows binaries are code-signed.
- [ ] Release notes and upgrade instructions are published.
- [ ] Rollback artifact is available.
- [ ] Production deployment owner has approved the LAN release.

## 12. Deferred Internet-production blockers

Do not expose the current release to an untrusted network until all of these are implemented and separately validated:

- [ ] Agent TLS/WSS transport.
- [ ] DPAPI-backed Agent token storage.
- [ ] Token rotation/revocation.
- [ ] Certificate provisioning and SAN validation.
- [ ] Bounded rotating Agent/service logs.
- [ ] Internet-facing authorization and network policy.
