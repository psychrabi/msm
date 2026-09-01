# MSM Milestone Status

## Repository-side milestones completed

- [x] Trusted-LAN `ws://` transport documented consistently.
- [x] Plaintext Agent token path documented as the active LAN credential model.
- [x] Agent/VNC credential separation retained.
- [x] Five-minute VNC ticket model retained and extended to session + monitor identity.
- [x] Worker retry/backoff has unit coverage.
- [x] Worker VNC port allocation across monitor workers has unit coverage.
- [x] Windows Agent installation smoke-test script added.
- [x] Release checklist and validation procedure reconciled with the active trusted-LAN product boundary.
- [x] Multi-agent and multi-monitor Viewer/Agent architecture documented.
- [x] Multi-monitor worker registry, proxy routing, monitor inventory, and combined Viewer card implemented.

## Still requires physical Windows validation

- [ ] Clean-machine install/uninstall and upgrade with active workers.
- [ ] Reboot/service recovery.
- [ ] Multiple simultaneous Windows sessions.
- [ ] Worker crash/recovery and backoff in real sessions.
- [ ] Lock/unlock and disconnect/reconnect behavior.
- [ ] Clipboard and Unicode clipboard behavior.
- [ ] Mouse/keyboard behavior across representative applications.
- [ ] Multiple monitor topology, secondary capture/input, hotplug, resolution changes, and exact Viewer layout reproduction.
- [ ] 24-hour soak test.
- [ ] Windows code signing and final artifact checksums.

Run `packaging/windows/test-agent-install.ps1` after installation for the automated service/firewall/token/identity/health checks.

## Deferred security milestone

The current LAN milestone intentionally does not enable Agent TLS/WSS, DPAPI-backed Agent token storage, token rotation/revocation, certificate provisioning/SAN validation, bounded rotating service logs, or Internet-facing authorization/network policy. Those are mandatory before an untrusted-network deployment.
