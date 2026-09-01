# MSM Trusted-LAN Release Checklist

This checklist describes the current release target: Windows Agent + Viewer over authenticated plain WebSocket on a trusted private LAN. It does **not** authorize Internet exposure.

## 1. Source and version

- [ ] Release version is consistent across application and Agent manifests.
- [ ] `Cargo.lock` and `bun.lock` are current.
- [ ] No access tokens, VNC passwords, tickets, certificates, private keys, or local credentials are committed.
- [ ] Release notes describe transport, protocol, installer, multi-monitor, and migration changes.

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

- [ ] Agent transport is documented as `ws://`/HTTP and restricted to a trusted private LAN.
- [ ] TCP/40123 is not exposed to the public Internet.
- [ ] `access-token` and identity state remain restricted to `SYSTEM`/Administrators.
- [ ] Session-worker permission for `monitors-<session>.json` does not grant access to sensitive Agent credentials.
- [ ] Viewer stores remembered Agent tokens only in the native credential store.
- [ ] VNC passwords are independent from Agent tokens.
- [ ] VNC tickets are short-lived and bound to session + monitor.
- [ ] Worker ports `5901-5999` are loopback-only and blocked inbound.
- [ ] Invalid Agent credentials return `401` without credential disclosure.
- [ ] Logs contain no Agent tokens, VNC passwords, or tickets.

## 4. Windows service

- [ ] Fresh installation succeeds on a clean Windows machine.
- [ ] Upgrade succeeds while workers are active.
- [ ] Service reaches `Running` after installation and after reboot.
- [ ] SCM recovery restarts the Agent after process failure.
- [ ] Service stop/uninstall leaves no worker processes or stale listeners.
- [ ] Reinstall is idempotent and preserves identity/access-token state.

## 5. Session, worker, and monitor lifecycle

- [ ] Primary worker is created for each eligible interactive session.
- [ ] Secondary monitor workers start on demand without duplicate workers.
- [ ] Worker registry is isolated by `(session_id, monitor_index)`.
- [ ] Worker crash causes controlled recovery.
- [ ] Repeated worker failure backs off rather than spawning continuously.
- [ ] Session disappearance terminates all of its monitor workers.
- [ ] Worker port exhaustion returns a controlled error.
- [ ] Multiple users/sessions and multiple monitors work simultaneously.
- [ ] Monitor inventory reports correct primary flag, resolution, and virtual-desktop coordinates.
- [ ] Secondary monitor capture and input target the correct physical display.
- [ ] Monitor hotplug/resolution/topology changes are handled or fail recoverably.

## 6. Viewer

- [ ] Multiple Agents can be connected simultaneously.
- [ ] Agent reconnect works after a temporary network outage.
- [ ] Manual Viewer disconnect remains intentional and does not auto-reconnect.
- [ ] Agent removal clears its saved credential.
- [ ] `401`, timeout, and protocol errors have useful user-facing messages.
- [ ] Multiple monitors for one session are grouped into one viewer card.
- [ ] Each monitor stream can connect/disconnect independently.
- [ ] Fullscreen combined viewing works.
- [ ] View-only/control mode is enforced as intended.
- [ ] Remote mouse/keyboard input works on each monitor, including negative/non-zero desktop origins.
- [ ] VNC disconnect cleans up Viewer state.

## 7. Clipboard

- [ ] Windows-to-Viewer and Viewer-to-Windows text clipboard work.
- [ ] Unicode text is preserved.
- [ ] Clipboard feedback loops are prevented.
- [ ] Clipboard failures do not kill workers.
- [ ] Locked/disconnected sessions are handled cleanly.

## 8. Packaging and upgrade

- [ ] Application installer installs and uninstalls cleanly.
- [ ] Agent package contains `msm-agent.exe`, `msm-agent-worker.exe`, and `install-agent.ps1`.
- [ ] Upgrade preserves identity/access-token state.
- [ ] Installer reapplies service recovery, firewall rules, and the split sensitive/monitor-metadata ACL model.
- [ ] `packaging/windows/test-agent-install.ps1` passes after installation.

## 9. Observability

- [ ] Agent startup/shutdown is observable through structured tracing.
- [ ] Worker PID/session/monitor lifecycle is logged.
- [ ] Worker crash/retry/backoff is logged.
- [ ] Authentication failures are logged without credentials.
- [ ] Operators know where to retrieve retained service logs.

## 10. Release-candidate soak test

Run the exact release candidate for at least 24 hours on a representative Windows host with multiple sessions/monitors.

- [ ] Reboot recovery passed.
- [ ] User login/logout and disconnect/reconnect passed.
- [ ] Worker crash recovery passed.
- [ ] Network outage/recovery passed.
- [ ] Viewer restart/recovery passed.
- [ ] Multi-monitor connect/disconnect/fullscreen/input passed.
- [ ] No unbounded process, memory, listener, or reconnect growth.
- [ ] No credential leakage observed.

## 11. Final sign-off

- [ ] All P0/P1 findings are closed.
- [ ] CI is green for the exact release commit.
- [ ] Windows installer has been tested on a clean machine.
- [ ] Release artifacts are checksummed and archived.
- [ ] Windows binaries are code-signed.
- [ ] Release notes/upgrade instructions are published.
- [ ] Rollback artifact is available.

## 12. Deferred untrusted-network blockers

Do not expose the current release to an untrusted network until separately implemented and validated:

- [ ] TLS/WSS Agent transport.
- [ ] DPAPI-backed Agent token storage.
- [ ] Token rotation/revocation.
- [ ] Certificate provisioning and SAN validation.
- [ ] Bounded rotating Agent/service logs.
- [ ] Internet-facing authorization/network policy.
