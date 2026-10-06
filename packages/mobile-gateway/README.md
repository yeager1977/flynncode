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

The Flynncode desktop app auto-starts this gateway inside its sidecar server:
no plugin config needed. The phone password is generated once, stored in the
desktop settings store, and stays stable across restarts, while the upstream
server password keeps rotating each launch. The gateway binds port 4097 on the
LAN and logs `phone:` URLs on startup. If the port is taken, the gateway stays
down and the desktop Phone card reports stopped; the sidecar itself keeps
running.

The gateway uses only `node:http`, `node:stream`, `node:stream/promises`,
`node:os`, and the global `fetch`/`Buffer`, so the same code runs under Bun
and Electron's Node runtime (the package's Node runtime test verifies this by
serving a real request through Electron with `ELECTRON_RUN_AS_NODE=1`; skipped
when no Electron binary is found).

Desktop Settings > Servers shows a Phone card with the LAN URLs and a QR code
for `/m`, plus copy buttons. Enter the stable phone credential once on the
phone; the session cookie persists after that.

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

1. Ensure the phone is on the same Wi-Fi network as the machine running the desktop app.
2. On the desktop, open Settings > Servers and find the Phone card. It lists
   the phone launcher URLs and shows a QR code for the first one.
3. Scan the QR code with the phone camera (or type the URL — no IP hunting:
   the card shows the exact `http://<machine-lan-ip>:4097/m` address). The QR
   points at `/m`, the session launcher.
4. Enter the phone password once when prompted (Safari remembers it for the session).
5. Share -> Add to Home Screen.

Live updates arrive while the app is open. Push notifications are unavailable
because iOS requires HTTPS for them; plain LAN HTTP does not qualify.

`http://flynncode.local:4097/m` may work as a best-effort fallback on networks
where mDNS resolves, but prefer the QR code or the exact LAN URL from the
Phone card — mDNS is not reliable on every router.

## Session launcher

The gateway serves a session launcher at `/m` (full address
`http://<machine-lan-ip>:4097/m` — scan the QR code on the desktop Phone card
instead of typing it). It
requires the same phone credential as every other gateway path. Add `/m` to the
home screen instead of `/` and you get a two-tap flow: tap the icon, tap a
session.

The launcher lists running sessions first under "Running now", then recent
sessions grouped by project. It fetches the most recent 30 sessions and shows
the ones you can prompt: subagent sessions are left out, because the app cannot
prompt them, though a running subagent still appears under "Running now" so you
can see that work is in progress. Older sessions remain reachable through the
full app's own project picker. The launcher itself is a plain list — tapping a
row opens that session in the full app, and all interaction happens there.

When something is wrong the launcher says so:

- **Server unreachable** — the page reports that the opencode server is
  unreachable and offers a reload link.
- **Credential rejected** — the page reports that the opencode server rejected
  the gateway's password. Check that `OPENCODE_SERVER_PASSWORD` matches the
  running server; the desktop app generates a new password each launch.
- **Partial data** — one of the two data sources failed, but the page still
  renders what it has and notes that some session data is unavailable.

The launcher is rendered by the gateway itself: `/m` is never proxied upstream
and requires the same authentication as every other path.

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