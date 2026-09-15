# @flynncode/mobile-gateway

Reach a running opencode server from a phone on the same network.

## Install as a plugin

Add the package path to the `plugin` array in your opencode config:

```json
{
  "plugin": ["file:///absolute/path/to/packages/mobile-gateway"]
}
```

Plugin options can carry the phone's credential, which takes precedence over the
environment:

```json
{
  "plugin": [
    ["file:///absolute/path/to/packages/mobile-gateway", { "password": "long-stable-phone-password" }]
  ]
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

## Run in the desktop app

The Flynncode desktop app loads this package as a plugin and the gateway starts
with the app. Plugins are dynamic-imported at runtime by path, so the app can
load this package's source directly from disk — no rebuild or bundling required.

The gateway uses only `node:http` and `node:stream`. Under the desktop's
Electron Node runtime there is no `Bun` global; the same code runs under both
Bun and Electron's Node, which the package's Node runtime test proves by
serving a real request through Electron with `ELECTRON_RUN_AS_NODE=1`.

The desktop app binds the opencode server to a random port each launch and
rotates `OPENCODE_SERVER_PASSWORD`, so leave `OPENCODE_MOBILE_UPSTREAM` unset and
let the plugin follow the server URL. Give the phone its own stable credential
via `OPENCODE_MOBILE_PASSWORD` or the plugin `password` option; see Security.

## Run standalone

```bash
cd packages/mobile-gateway
OPENCODE_SERVER_PASSWORD=choose-something bun run src/bin.ts
```

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_SERVER_PASSWORD` | required | Upstream password; also the gateway credential when `OPENCODE_MOBILE_PASSWORD` is unset |
| `OPENCODE_MOBILE_PASSWORD` | unset | The phone's credential; falls back to `OPENCODE_SERVER_PASSWORD` when unset |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Upstream username |
| `OPENCODE_MOBILE_HOST` | `0.0.0.0` | Listen host |
| `OPENCODE_MOBILE_PORT` | `4097` | Listen port, `0` for ephemeral |
| `OPENCODE_MOBILE_UPSTREAM` | `http://127.0.0.1:4096` | Main server URL |

The two passwords have different jobs. `OPENCODE_MOBILE_PASSWORD` is what the
phone types and stays stable across restarts. The upstream hop always uses
`OPENCODE_SERVER_PASSWORD` (username from `OPENCODE_SERVER_USERNAME`); the phone
never sees it, so the desktop app can rotate it on every launch without breaking
the phone.

The upstream URL resolves in this order: `OPENCODE_MOBILE_UPSTREAM`, then the
plugin's live `serverUrl`, then `http://127.0.0.1:4096`. When running as a
plugin, leave `OPENCODE_MOBILE_UPSTREAM` unset so the gateway follows the server
URL — desktop builds bind a random port each launch, which a fixed URL cannot
track.

## On the phone

1. Ensure the phone is on the same network as the machine running opencode.
2. Open `http://<machine-lan-ip>:4097` in Safari.
3. Enter the gateway username and the phone password when prompted.
4. Share -> Add to Home Screen.

Live updates arrive while the app is open. Push notifications are unavailable
because iOS requires HTTPS for them; plain LAN HTTP does not qualify.

## Security

- `OPENCODE_MOBILE_PASSWORD` is the phone's only credential and does not rotate.
  Choose a long, unique value and keep it stable across desktop restarts.
- Anyone on the local network who knows the phone's credential gets full
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

If credentials are correct but you still get a 401, the upstream opencode server
itself rejected the credential probe, which usually means `OPENCODE_SERVER_PASSWORD`
does not match the running server's password. An unreachable upstream answers
503 with no credential challenge; a 401 carries a `www-authenticate` header and
means the credential was rejected. If the upstream goes down after a valid
session is established, the gateway returns 502 for proxied requests until the
upstream is running again.

The PTY terminal is not available through the gateway (it does not proxy
WebSocket upgrades), so the terminal panel in the web UI will not work from the
phone.