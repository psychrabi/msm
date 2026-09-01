# MSM Release Validation Procedure

## Automated gates

Run from the exact release commit:

```powershell
bun install --frozen-lockfile
bun run build
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --release -p msm-agent
powershell -NoProfile -ExecutionPolicy Bypass -File packaging/windows/build-agent.ps1
```

Require the GitHub `production-gate` workflow to be green for the exact release commit.

## Windows installation smoke test

From an elevated PowerShell prompt after installing the Agent:

```powershell
.\packaging\windows\test-agent-install.ps1
```

The smoke test verifies service registration/state/account, Agent and worker binaries, identity/token files, firewall rules, unauthenticated/authenticated `/health`, and loopback-only worker listeners.

## Manual Windows matrix

1. Fresh install on a clean Windows host.
2. Connect from Viewer using the provisioned Agent token.
3. Enumerate all eligible sessions.
4. Verify monitor inventory for every active session.
5. Verify primary and secondary monitors show the correct physical desktop.
6. Verify monitor-specific mouse/keyboard input, including non-zero or negative virtual-desktop origins.
7. Verify combined Viewer card and fullscreen behavior.
8. Verify per-monitor connect/disconnect state and manual-disconnect suppression.
9. Verify Unicode clipboard in both directions.
10. Kill primary and secondary workers and verify recovery/backoff.
11. Disconnect/log off a user session and verify all workers for that session are cleaned up.
12. Reconnect/log in and verify worker recreation plus monitor metadata regeneration.
13. Restart the Agent service and verify recovery.
14. Reboot Windows and verify automatic service startup.
15. Repeat installation as an upgrade while workers are active.
16. Uninstall and verify SCM/process/listener cleanup.
17. Repeat installation to verify idempotence.
18. Exercise monitor hotplug, resolution changes, and topology changes.

## Soak

Run a representative multi-session, multi-monitor machine for at least 24 hours and record Agent/worker process counts, memory usage, service/worker restart counts, Viewer reconnects, network interruption/recovery events, clipboard/input failures, monitor topology changes, and unexpected listeners.

The release is not production-ready until the manual matrix and soak evidence are recorded against the exact artifact checksums.
