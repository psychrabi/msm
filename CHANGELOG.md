# Changelog

## [1.2.0] - 2026-09-14

TLS everywhere, automated setup, and a round of architecture deepening.

### Added
- TLS re-enabled for agent and app: agent serves `wss` via rustls; the app
  verifies with OS native roots, so self-signed agent certs work once
  imported to Trusted Root.
- One-command setup: `install-agent.ps1 -GenerateCert` (cert, install,
  live TLS health probe, prints the usable bearer token).
- `new-agent-cert.ps1`: self-signed cert+key with LAN SANs, end-entity
  constraints, and fingerprint output.
- `install-app-cert.ps1`: idempotent Trusted Root import with thumbprint
  check and stale same-subject purge.
- Agent installer zip now ships the full kit (binaries, all three scripts,
  README.txt).
- Matt Pocock skills setup: `AGENTS.md`, `docs/agents/` (tracker, labels,
  domain).

### Fixed
- Agent cert stamped `CA:FALSE` + serverAuth EKU (openssl 3.x marks
  `req -x509` output as CA certs, which rustls rejects as server leafs).
- Installer prints the DPAPI-decrypted bearer token instead of the
  encrypted token-file blob.
- Removed a contradictory TLS check in the installer.

### Changed
- Architecture review pass: viewer card split out of MonitoringPage,
  connection runtime bookkeeping extracted from the god-hook, worker
  spawn/kill consolidated into the session supervisor, pure viewer-merge /
  VNC-URL / remotes-assembly seams, centralized viewer key formats.

## [1.1.0] - 2026-09-14

- Version bump only.

## [1.0.0]

- Initial release: Tauri monitoring app, Windows agent with per-session
  VNC workers, multi-monitor viewers, DPAPI-backed token storage.
