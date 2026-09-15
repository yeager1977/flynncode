# Mobile Gateway Plugin — Design

Date: 2026-09-15
Status: Approved

## Problem

Sessions run on a workstation, but the workstation is not always in reach. There
is no supported way to reach the same opencode server, and the sessions it holds,
from an iPhone on the same network.

Constraints discovered while exploring the repo:

- The opencode plugin API cannot register HTTP routes on the main server. The
  route tree is static (`packages/opencode/src/server/routes/instance/httpapi/api.ts`).
- Plugin code does run in the server's Bun process, and three built-in plugins
  already open their own listeners there for OAuth callbacks
  (`plugin/openai/codex.ts:161`, `plugin/digitalocean.ts:64`,
  `plugin/snowflake-cortex.ts:163`), closing them via `Hooks.dispose`.
- `plugin.server(input)` is **not** invoked at `opencode serve` startup. It is
  demand-driven per directory: `InstanceContextMiddleware` →
  `InstanceStore.load` → `InstanceBootstrap.run` → `Plugin.init()`
  (`packages/opencode/src/project/bootstrap.ts:38`). Under `opencode serve` with
  no traffic, plugins never load at all.
- The server binds `127.0.0.1` by default and supports only Basic auth
  (`OPENCODE_SERVER_PASSWORD`).
- The existing web UI (`packages/app`, SolidJS + Tailwind) already ships a PWA
  manifest, Apple meta tags, and standalone display-mode handling. It derives its
  backend from `location.origin` (`packages/app/src/entry.tsx:99-104`) and
  accepts `?auth_token=` (`entry.tsx:154-163`), so serving it from another origin
  transparently retargets its API calls. It already contains session list,
  timeline, prompt input, and permission/question dialogs.
- iOS refuses install and push notifications without HTTPS. Plain-LAN HTTP
  therefore cannot deliver Web Push or a service worker.

The machine doing the development and build is Linux, so a native `.ipa` cannot
be produced locally.

## Goal

Reach the running server's sessions from an iPhone on the same LAN, with the
ability to read sessions, send prompts, abort runs, and answer permission and
question prompts.

Non-goals:

- No dedicated mobile UI. The existing app is served as-is.
- No native Swift app.
- No TLS termination, service worker, or Web Push.
- No reimplementation of any session, permission, or question API.
- No multi-user accounts or per-device authorization levels.

## Approach

### 1. Package layout

A new installable package, `packages/mobile-gateway`, published in-repo as
`@flynncode/mobile-gateway` with a `flynncode-mobile` bin, and two entrypoints
that share one gateway module:

```
packages/mobile-gateway/
  package.json          exports: "./server" (plugin), "./bin" (standalone)
  src/gateway.ts        listener, proxy, auth; runtime-agnostic of how it starts
  src/index.ts          plugin entry: server(input) -> Hooks, dispose()
  src/bin.ts            standalone CLI entry
  test/                 unit + integration tests
```

`package.json` declares `exports["./server"]` for the plugin, plus a `bin`, and
an `engines.opencode` range so `opencode` can load it. This matches the entrypoint
contract in `packages/opencode/src/plugin/shared.ts`.

Two ways to start it, both calling the same `gateway.ts`:

- **Plugin entry** (`exports["./server"]`) — starts the gateway when
  `plugin.server()` runs, closes it in `Hooks.dispose`. Covers the TUI and
  `opencode web` workflows, and `opencode serve` once any request has loaded the
  instance.
- **Standalone bin** — reads config from environment variables and needs no
  plugin load. This is the reliable path for headless `opencode serve`, because
  the plugin's demand-driven init would otherwise mean no listener until after
  the first request.

The gateway must be started only once per process; both entries funnel through
the same singleton guard in `gateway.ts`.

### 2. Gateway behaviour

A reverse proxy that listens on the LAN and forwards to the main server:

- Binds `0.0.0.0`, default port `4097`, overridden by `OPENCODE_MOBILE_PORT`.
  Port `0` binds an ephemeral port and logs the chosen one.
- Refuses to bind unless `OPENCODE_SERVER_PASSWORD` is set, logging the reason.
- Proxies every path, including `/api/event`, `/event`, and `/api/session/:id/event`
  SSE streams, preserving streaming semantics (no buffering, no body
  coalescing). Verified against the proxy header rules in
  `packages/opencode/src/server/shared/ui.ts:30-38`, which strips
  `content-encoding`, `content-length`, and `transfer-encoding` when forwarding
  decoded bodies; the gateway applies the same rule.
- Injects `Authorization: Basic` upstream from the environment so the phone
  never needs to hold the server password for ordinary API calls.
- Serves nothing of its own. The main server already serves the UI at `/`.
- Closes cleanly via `Hooks.dispose` (plugin path) or signal handling (bin path).

### 3. Authentication

The gateway is the only new attack surface, so it authenticates every request:

- The phone presents the server password once using the browser's native Basic
  prompt. The gateway verifies it by making an upstream request with those
  credentials; only a successful upstream response issues a session cookie.
- After verification, upstream requests always carry the Basic header derived
  from `OPENCODE_SERVER_PASSWORD` in the gateway's own environment, not the
  credentials presented by the phone. A valid cookie is sufficient thereafter;
  the phone is never trusted to supply upstream credentials per request.
- The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and carries a random
  token. Tokens live in memory only and are dropped on gateway restart.
- The cookie is required in addition to Basic because `EventSource` cannot send
  custom headers, and same-origin cookies ride along automatically on SSE
  requests. Without a cookie the stream endpoints would be unreachable.
- Verification failure returns 401 with `WWW-Authenticate` and issues no cookie.
- Requests without a valid cookie never reach the upstream, whether or not they
  carry a Basic header.
- Credentials never appear in the served assets; the app picks up its origin
  automatically and does not need `?auth_token=`.

### 4. Phone delivery

Open `http://<lan-ip>:4097` in Safari, then Share → Add to Home Screen. The
existing manifest and Apple meta tags make it launch standalone.

Known limitation: no service worker and no Web Push on plain HTTP, because iOS
requires HTTPS for both. Live updates work while the app is open, via SSE. Push
notifications would require TLS with a trusted certificate on the LAN, which
means a real domain or a local CA — explicitly out of scope.

### 5. Testing

- Unit tests for session-token issue/verify and the credential-verification
  handshake.
- Integration tests that start an upstream `Bun.serve` fixture and the gateway,
  then assert: bad password is rejected, good password is proxied, an SSE
  response streams incrementally rather than buffering, and proxy response
  headers are forwarded correctly.
- A manual checklist: gateway binds and logs its port, rejects a bad password,
  serves the UI, streams events, sends a prompt from a phone-sized viewport, and
  answers a permission prompt.
- No mocks. Tests drive real listeners, per the project testing guidance.

## Risks

- **Port collision** on `4097`. Mitigated by the `OPENCODE_MOBILE_PORT` override
  and by logging the bound port.
- **Plugin-vs-bin drift.** Both entries must construct identical gateway options;
  this is enforced by keeping option resolution in `gateway.ts` and having both
  entries call one factory.
- **Exposure if the password is weak or shared.** The gateway is reachable by
  anyone on the LAN who knows it. The design keeps the surface read/write to the
  agent and defers stronger pairing to a future revision.
