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

## Troubleshooting auth failures

If credentials are right but you still get a 401, the upstream opencode server
itself rejected the credential probe. If the upstream is not running at all,
the gateway answers 503 instead — a 401 with a fresh, correct password usually
means the upstream password does not match `OPENCODE_SERVER_PASSWORD`.