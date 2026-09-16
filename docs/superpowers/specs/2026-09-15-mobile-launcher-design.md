# Mobile Launcher Design

Date: 2026-09-15
Status: Approved

## Problem

The mobile gateway works: from an iPhone on the LAN, `http://<lan-ip>:4097` serves the
real opencode web UI, authentication is enforced, and driving the app was verified at an
iPhone viewport (393x660) against a live server — session list, message timeline,
composer, model selector, and stop button all render and function.

One gap makes it impractical as a daily remote control. **The app tracks which projects
the user has opened in device-local storage**, not on the server
(`packages/app/src/pages/home/home-controller.ts:76` reads `projects` from the persisted
`server.v3` store). The server knows all seven projects; a fresh phone knows none, so the
home screen shows "Nothing here yet". The only way to reach an existing session is to
open a folder picker and **type an absolute filesystem path**, then press Enter. On a
phone keyboard that is slow and error-prone, and it must be repeated per device and per
browser storage reset.

Verified during investigation:

- `GET /project` returns all projects (`id`, `worktree`, `time`, `sandboxes`).
- `GET /api/session?limit=N` returns sessions with `location.directory`, so a session can
  be attributed to its project without extra lookups.
- `GET /api/session/active` returns a map of currently executing session IDs.
- Deep links work. The app routes `/:dir/session/:id` where `:dir` is the directory
  encoded with the repo's URL-safe base64 (`packages/core/src/util/encode.ts`
  `base64Encode`: standard base64 with `+`→`-`, `/`→`_`, padding stripped). Confirmed by
  rendering `/<slug>/session` and `/<slug>/session/<id>` at iPhone size: the second loads
  the real conversation with its composer.

## Goal

From a phone, reach any session in two taps without typing a path.

Non-goals:

- No push notifications. They require HTTPS, and the deployment is deliberately plain-LAN
  HTTP.
- No offline support or service worker.
- No replacement of the existing UI. Tapping through lands in the real app.
- No patching of `packages/app`. This repo nightly-syncs from upstream, so edits there
  create recurring merge conflicts.
- No new session, permission, or question behavior.

## Approach

### 1. A launcher page served by the gateway

The gateway already serves the LAN, already terminates authentication, and is Flynncode's
own package (safe to edit). It gains one authenticated route: **`GET /m`**, returning a
self-contained HTML page. Everything else continues to proxy to the main server
unchanged.

The page is rendered entirely server-side as a single HTML document with inline CSS. It
uses **no JavaScript**: every interaction is a plain anchor navigation, so there is no
client-side state to get wrong and nothing to load before the page is usable. No
framework, no build step, no new dependency. It is small enough to inline as template
functions.

`GET /m` and `GET /m/` are equivalent; the launcher owns both so a trailing slash does not
fall through to the proxy.

### 2. Content

Two sections, in this order:

**Running now.** Sessions currently executing, from `GET /api/session/active`, which
returns a map of session ID to `{ type: "running" }` and carries no title. Titles and
directories are resolved from the recent-sessions list, which is already fetched; a
running session not present in that list (older than the recent window) is still shown,
labelled with its ID truncated for display, because knowing that *something* is running
matters more than its title.

Rendered first and visually distinct, because a running session is the one most likely to
need the user's attention. When nothing is running, the section is replaced by a single
quiet line rather than an empty box.

**Recent sessions.** The most recent sessions across all projects, newest first, from
`GET /api/session?limit=30&order=desc` (verified: `order=desc` is honored and returns
sessions by descending update time), grouped under their project. Each row shows the
session title and a relative time ("12m ago"), and the project heading is derived from
`location.directory` using its final path segment. Groups are ordered by their most
recent session, so the project last worked in appears first.

Project headings are display labels only. A project whose directory is `/` renders as `/`,
and a session with no `location.directory` is grouped under a single "Unknown project"
heading placed last.

Each row links to `/<slug>/session/<sessionID>` using the URL-safe base64 slug. This is a
plain anchor: the browser navigates to the existing app, which loads that session
directly.

Sessions already listed under "Running now" are excluded from "Recent sessions" so no
session appears twice.

Subagent sessions are excluded from "Recent sessions". The app identifies a subagent session
by a non-empty `parentID` and refuses to prompt it ("Subagent sessions cannot be prompted"),
so listing them would mostly produce dead ends: against a real desktop server they were 27 of
the 30 most recent sessions. A subagent that is currently running still appears under
"Running now" with a `subagent` badge, because there the purpose is seeing that work is in
progress rather than prompting it. The fetch limit still counts subagents, so the number of
visible recent rows can be below the limit.

### 3. Data flow

```
phone (authenticated cookie) → GET /m
  gateway (node:http)
    ├─ reads the session cookie, exactly as every other request
    ├─ fetch GET {upstream}/api/session/active           (env credentials)
    └─ fetch GET {upstream}/api/session?limit=30&order=desc
  gateway groups the sessions by location.directory
phone taps a row → /<slug>/session/<id> → normal proxy path → existing app
```

Only two upstream calls are needed. Project grouping comes from each session's
`location.directory`, so `/project` is not fetched; this also means a project with no
recent sessions is simply absent, which is the desired behavior for a launcher.

The gateway calls upstream with its own environment credentials, so the phone's credential
never travels upstream. `/m` is served locally and is never proxied, so the launcher cannot
be reached by accident through the proxy path.

### 4. Failure behavior

The launcher must never appear broken:

- If any upstream fetch fails, the page still renders with the sections that succeeded and
  a plain line naming which part is unavailable. A total upstream failure produces a page
  saying the server is unreachable, with a reload link — not a gateway error.
- Upstream requests use a bounded timeout (5 seconds, matching the existing probe in
  `src/upstream.ts`) so a hung server cannot hang the launcher.
- Authentication is unchanged: an unauthenticated request to `/m` gets the same 401 with
  `www-authenticate` as any other path, so the browser prompts and then the cookie is
  issued by the existing handshake. This is implemented by running the launcher route
  through the same credential check `createGateway` already performs, decided **before**
  the request is routed anywhere, rather than adding a second auth path. A request that
  passes the check with Basic credentials still receives the session cookie exactly as it
  would for any other path.
- Upstream requests from the launcher use the gateway's environment credentials, so the
  phone's credential never travels upstream; a failure of either call degrades the page
  rather than failing it.
- No session data is cached or logged by the gateway.

### 5. Styling

Mobile-first, dark-mode aware via `prefers-color-scheme`, tap targets at least 44px tall,
system font stack only. It must be usable one-handed and readable in sunlight: large text,
generous spacing, no horizontal scroll at 320px width. A `<meta name="viewport">` with
`viewport-fit=cover` and safe-area padding keeps it clear of the notch and home indicator
when added to the home screen, matching the main app's approach
(`packages/app/index.html:7`, `packages/app/src/pages/layout-new.tsx:28-31`).

Installing it to the home screen is expected: the page declares
`apple-mobile-web-app-capable` and a title so it launches standalone like the main app.

### 6. Testing

- Unit tests for the grouping function: sessions attributed to projects by
  `location.directory`, groups ordered by most recent session, sessions with no `location`
  handled without throwing.
- Unit tests for the slug function, asserting it matches the repo's `base64Encode` output
  for representative directories including `/` and paths with spaces and unicode.
- Unit tests for the HTML renderer: titles are HTML-escaped, so a session titled with
  `<script>` cannot inject markup.
- An integration test that starts a mock upstream, requests `/m` through the gateway with
  valid and invalid credentials, and asserts 401 versus a page containing the expected
  session titles and deep links.
- An integration test asserting a partial upstream failure still renders a page.
- Manual verification at iPhone viewport size (the technique already used: Playwright with
  a device profile against the live gateway) confirming no horizontal scroll and that a
  row tap lands in the real session view.

## Risks

- **Session titles are attacker-influenced text.** They originate from model output and
  user prompts. The renderer must HTML-escape every interpolated value; this is covered by
  a dedicated test.
- **The launcher duplicates a little app knowledge** (the deep-link route shape and the
  base64 encoding). If upstream changes the route, the launcher breaks while the rest of
  the gateway keeps working. Mitigated by keeping the encoding function's expected output
  pinned to the repo's implementation in tests, so a change is caught rather than silently
  producing dead links.
- **`/m` occupies a path on the gateway origin.** If upstream ever serves a real `/m`, the
  gateway route shadows it. Acceptable for a single-user LAN tool; noted so the choice is
  deliberate.
