# MSM Milestone Status

## Completed in this milestone pass

- [x] Trusted-LAN `ws://` transport documented consistently across architecture, hardening, README, and release notes.
- [x] Plaintext Agent token path documented explicitly as the active LAN credential model.
- [x] Agent/VNC credential separation retained.
- [x] Session-bound five-minute VNC ticket model retained.
- [x] Worker retry backoff extracted into a testable helper and covered by unit tests.
- [x] Worker VNC port allocation covered by unit tests, including exhaustion.
- [x] Windows Agent installation smoke-test script added.
- [x] Release checklist rewritten for the actual trusted-LAN product boundary.
- [x] Release notes added for 1.0.0.
- [x] Architecture documentation reconciled with the active implementation.

## Still requires physical Windows validation

These are environment-dependent and cannot be proven by repository-only checks:

- [ ] Clean-machine install and uninstall.
- [ ] Upgrade with active workers.
- [ ] Reboot/service recovery.
- [ ] Multiple simultaneous Windows sessions.
- [ ] Worker crash/recovery and backoff in a real Windows session.
- [ ] Lock/unlock and disconnect/reconnect behavior.
- [ ] Clipboard and Unicode clipboard behavior.
- [ ] Mouse/keyboard behavior across representative applications.
- [ ] Monitor hotplug/resolution changes.
- [ ] 24-hour soak test.
- [ ] Windows code signing and final artifact checksums.

Run `packaging/windows/test-agent-install.ps1` immediately after installation to automate the service, ACL, firewall, token, identity, and authenticated/unauthenticated health checks.

## Deferred security milestone

The current LAN milestone intentionally does not enable these features:

- [ ] Agent TLS/WSS.
- [ ] DPAPI-backed Agent token storage.
- [ ] Token rotation/revocation.
- [ ] Certificate provisioning/SAN validation.
- [ ] Bounded rotating service logs.
- [ ] Internet-facing authorization/network policy.

Those items are mandatory before an untrusted-network or Internet deployment.
