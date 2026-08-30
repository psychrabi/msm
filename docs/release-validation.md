# MSM Release Validation Procedure

## Automated

Run the repository gates from the release commit:

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

On GitHub, require the `production-gate` workflow to be green for the exact release commit.

## Windows installation smoke test

From an elevated PowerShell prompt after installing the Agent:

```powershell
.\packaging\windows\test-agent-install.ps1
```

The smoke test verifies:

- service registration and `Running` state;
- LocalSystem service account;
- Agent and worker binaries;
- identity and plaintext access-token files;
- Agent data-directory ACLs;
- Agent/VNC firewall rules;
- unauthenticated `/health` returns `401`;
- authenticated `/health` returns `200` and device identity;
- representative VNC listeners are loopback-only.

## Manual Windows matrix

1. Fresh install on a clean Windows host.
2. Connect from Viewer with the provisioned Agent token.
3. Enumerate sessions and open each eligible session.
4. Verify view-only rendering.
5. Verify explicit control mode for mouse and keyboard.
6. Verify Unicode clipboard in both directions.
7. Kill a worker and verify supervisor recovery.
8. Disconnect a user session and verify worker cleanup.
9. Reconnect the user and verify worker recreation.
10. Restart the Agent service and verify recovery.
11. Reboot Windows and verify automatic service startup.
12. Repeat installation as an upgrade while workers are active.
13. Run uninstall and verify SCM/process/listener cleanup.
14. Repeat installation to verify idempotence.

## Soak

Run a representative multi-session machine for at least 24 hours and record:

- Agent process count;
- worker process count per session;
- memory usage;
- service restart count;
- worker restart count;
- Viewer reconnects;
- network interruption/recovery events;
- clipboard failures;
- input failures;
- unexpected listeners.

The release is not production-ready until the Windows manual matrix and soak evidence are recorded against the exact artifact checksums.
