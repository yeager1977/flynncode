# @flynncode/mobile-gateway

Reach a running opencode server from a phone on the same network.

## Install as a plugin

Add the package path to the `plugin` array in your opencode config:

```json
{
  "plugin": ["file:///absolute/path/to/packages/mobile-gateway"]
}
```

Then start opencode with the server password set:

```bash
OPENCODE_SERVER_PASSWORD=choose-something \
opencode
```

The plugin prints its listen URL when it starts. The plugin only starts once
opencode loads the project instance, so for headless `opencode serve` use the
bin instead.

## Run standalone

```bash
cd packages/mobile-gateway
OPENCODE_SERVER_PASSWORD=choose-something bun run src/bin.ts
```

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_SERVER_PASSWORD` | required | Upstream password and gateway credential |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Upstream username |
| `OPENCODE_MOBILE_HOST` | `0.0.0.0` | Listen host |
| `OPENCODE_MOBILE_PORT` | `4097` | Listen port, `0` for ephemeral |
| `OPENCODE_MOBILE_UPSTREAM` | `http://127.0.0.1:4096` | Main server URL |

## On the phone

1. Ensure the phone is on the same network as the machine running opencode.
2. Open `http://<machine-lan-ip>:4097` in Safari.
3. Enter the server username and password when prompted.
4. Share -> Add to Home Screen.

Live updates arrive while the app is open. Push notifications are unavailable
because iOS requires HTTPS for them; plain LAN HTTP does not qualify.

## Security

- Anyone on the local network who knows `OPENCODE_SERVER_PASSWORD` gets full
  control of the agent through the gateway, including approving shell-command
  permissions. The gateway is exactly as strong as that password; use a long,
  unique one.
- The gateway binds `0.0.0.0` by default, so it is reachable from the whole LAN.
  Set `OPENCODE_MOBILE_HOST=127.0.0.1` to restrict it to the machine itself.
- Traffic is plain HTTP. There is no TLS, so anyone who can passively observe
  the network can capture the session cookie or the Basic credential handshake
  without knowing the password. Do not use this on untrusted networks (public
  Wi-Fi, shared/hotel/corporate networks).
- The session cookie is deliberately not marked `Secure` because that attribute
  requires HTTPS, which plain-LAN HTTP cannot provide.
- There is no rate limiting or lockout on credential attempts.
- Push notifications and a service worker are unavailable because iOS requires
  HTTPS for both; see "On the phone" above.

## Troubleshooting auth failures

If credentials are right but you still get a 401, the upstream opencode server
itself rejected the credential probe. If the upstream is not running at all,
the gateway answers 503 instead — a 401 with a fresh, correct password usually
means the upstream password does not match `OPENCODE_SERVER_PASSWORD`.

If the opencode server goes down after a valid session is established, the
gateway returns 502 for proxied requests until the upstream is running again.

The PTY terminal is not available through the gateway (it does not proxy
WebSocket upgrades), so the terminal panel in the web UI will not work from the
phone. Everything else — sessions, messages, prompts, abort, permissions, and
questions — does work.