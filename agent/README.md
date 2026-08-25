# MSM Agent

`msm-agent` is the standalone headless component installed on managed computers.

## Development

```bash
cargo run -p msm-agent
```

Print the device identity and development pairing token:

```bash
cargo run -p msm-agent -- --print-identity
```

By default the development control endpoint binds to `127.0.0.1:40123`.

For LAN testing:

```bash
cargo run -p msm-agent -- --listen 0.0.0.0:40123
```

The viewer connects to `/ws` using a bearer token.

## Responsibilities

The agent owns machine identity, session discovery, per-session VNC lifecycle, OS-specific capture/input, local policy enforcement, and the production outbound relay connection.

The agent is deliberately independent of Tauri and must be able to run as a native OS service without an interactive desktop.

## Security

The current token is a development pairing mechanism. The direct LAN endpoint is not a production transport and should not be exposed to the public Internet. Production connectivity will use device keys/certificates, short-lived session credentials, encrypted transport, and an outbound relay.
