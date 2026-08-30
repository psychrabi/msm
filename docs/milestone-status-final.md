# MSM Final Milestone Index

The trusted-LAN milestone implementation is on this branch. The authoritative documents are:

- `docs/architecture.md` — active system architecture and transport.
- `docs/production-hardening.md` — current security boundary and deferred hardening.
- `docs/release-checklist.md` — release gate.
- `docs/release-notes-1.0.0.md` — 1.0.0 scope and migration behavior.
- `docs/release-validation.md` — automated, Windows smoke-test, manual matrix, and soak procedure.
- `docs/milestone-status.md` — completed work versus physical Windows validation still required.

The current release uses authenticated `ws://` on a trusted private LAN and plaintext Agent token storage under `C:\ProgramData\MSM\agent\access-token`. TLS/WSS and DPAPI are explicitly deferred and must be completed before any untrusted-network deployment.
