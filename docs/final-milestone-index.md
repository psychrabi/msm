# MSM Final Milestone Index

The trusted-LAN milestone implementation is on this branch.

- Architecture: `docs/architecture.md`
- Hardening: `docs/production-hardening.md`
- Release gate: `docs/release-checklist.md`
- Release notes: `docs/release-notes-1.0.0.md`
- Validation procedure: `docs/release-validation.md`
- Milestone status: `docs/milestone-status.md`
- Windows smoke test: `packaging/windows/test-agent-install.ps1`

Current release boundary: authenticated `ws://` on a trusted private LAN with plaintext Agent token storage at `C:\ProgramData\MSM\agent\access-token`. TLS/WSS and DPAPI remain deferred and are mandatory before untrusted-network deployment.
