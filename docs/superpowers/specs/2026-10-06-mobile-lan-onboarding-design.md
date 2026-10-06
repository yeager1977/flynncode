# Mobile LAN Onboarding — Design

Date: 2026-10-06
Status: Approved (brainstorming sections 1-5 accepted)
Extends: `2026-09-15-mobile-gateway-design.md`, `2026-09-15-mobile-launcher-design.md`

## Problem

The gateway works (`packages/mobile-gateway`, LAN reverse proxy on `0.0.0.0:4097`
with `/m` launcher), but the #1 phone job — monitor + prompt — is blocked at
discovery: finding the desktop URL and opening it on the phone.

Today the plugin only logs `listening on http://0.0.0.0:4097`. There is no LAN IP
discovery, no QR, no mDNS, and no Desktop UI surface. The user must find the
machine LAN IP by hand and type `http://<lan-ip>:4097/m` on a phone keyboard.

Scope for this phase: same-LAN only, then remote later.

## Goal

Desktop → scan → monitor + prompt, without typing an IP.

Non-goals:

- No auth change (stable `OPENCODE_MOBILE_PASSWORD` + session cookie stay).
- No TLS, no push notifications, no service worker (still plain-LAN HTTP).
- No remote / away-from-home reach (deferred to Tailscale/TLS phase).
- No new session, permission, or mobile UI behavior.
- No password embedded in QR.

## Approach

### 1. Architecture

Keep the existing shape: `mobile-gateway` stays a LAN reverse proxy, desktop
keeps loading it as a plugin with rotating upstream password + stable phone
password.

Changes:

- Gateway exposes a localhost-only status endpoint
  (`/flynncode-mobile-status`) returning `{ port, lanUrls, mdnsUrl,
  launcherUrl }` with LAN IP discovery via `os.networkInterfaces()`.
- Desktop main process reads that on startup, exposes via existing
  `window.api` IPC (`getMobileGatewayStatus`), renders in Settings > Servers.
- QR encodes the `/m` URL only; user still types the stable phone password
  once, then the session cookie persists. mDNS `flynncode.local` is
  best-effort fallback.

### 2. Components

1. **Gateway discovery (`packages/mobile-gateway`)** — new `lan-ips.ts`
   helper (IPv4, non-internal only) + `status()` builder. Log line changes
   from `listening on http://0.0.0.0:4097` to real URLs, e.g.
   `http://192.168.1.42:4097/m`. No new deps.
2. **Desktop main (`packages/desktop/src/main/`)** — read gateway
   port/status after sidecar start, expose via `window.api` IPC. No new
   process.
3. **Desktop UI (`packages/app/.../servers.tsx` + new `phone-card`)** —
   "Phone" card at top of Servers tab: status dot, LAN URL list, client-side
   canvas QR (no network fetch; prefer an existing UI dependency or a tiny
   vendored encoder — no new runtime network dependency), Copy button, `OPENCODE_MOBILE_PASSWORD` hint. Follows existing
   `SettingsListV2` + i18n pattern, no hardcoded strings.
4. **Docs** — update `mobile-gateway/README.md` onboarding (scan QR → Add to
   Home Screen).

### 3. Data flow

1. Desktop launches → sidecar on random port + rotated
   `OPENCODE_SERVER_PASSWORD` → loads `mobile-gateway` plugin → gateway binds
   `4097`, computes LAN IPs + `/m` URL.
2. Gateway logs full URLs. Desktop main polls localhost status → Phone card
   renders URLs + QR.
3. Phone: scan QR → `http://<lan-ip>:4097/m` → Basic auth with stable phone
   password → cookie → launcher Running-now + recents → tap opens full app
   session view. Same flow as today, now discoverable.

Out of scope: password in QR, auto-login tokens, WebSocket PTY proxying.

### 4. Error handling

- **No LAN found**: card shows `127.0.0.1` + "same WiFi" hint, QR hidden.
- **Port conflict** (`4097` taken): card shows stopped state + log reason. No
  auto port-hopping — keeps printed/QR URL stable.
- **Upstream down / 401**: unchanged — `/m` renders Unreachable /
  Unauthorized pages with reload link.
- **mDNS unavailable**: silently omitted, LAN IPs remain primary.
- **Password unset**: card shows setup hint for `OPENCODE_MOBILE_PASSWORD` /
  plugin `password` option, never displays the secret.

### 5. Testing

- `packages/mobile-gateway`: unit tests for LAN-IP filter (loopback /
  link-local excluded, IPv4 only) + status URL builder (`http://<ip>:4097/m`
  string asserted); existing `bun test` + `bun typecheck` from package dir.
- Desktop: existing IPC surface test if touched; manual verify on same WiFi —
  QR scans to `/m`, launcher loads, prompt send works from phone Safari.
- No phone-hardware e2e.
- Success criteria: desktop → scan → monitor + prompt without typing an IP.

## Update (2026-10-06): sidecar auto-start replaces plugin loading

The Architecture section above assumed the desktop loads this package as a
plugin. That was never implemented: no desktop code referenced the package and
no user config includes it, so port 4097 stayed closed and the Phone card
correctly showed stopped. The desktop now auto-starts the gateway inside its
sidecar (`packages/desktop/src/main/sidecar.ts` via
`mobile-gateway-launch.ts`) with a stable phone password persisted in the
desktop settings store. The `mdnsUrl` field remains deferred as documented in
the final review.
