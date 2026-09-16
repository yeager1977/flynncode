# Mobile Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated `GET /m` page to the mobile gateway that lists running and recent sessions as tap targets, so a phone reaches any session without typing a filesystem path.

**Architecture:** Three new modules in `packages/mobile-gateway/src`. `launcher.ts` holds pure helpers (URL-safe base64 slug, project label, relative time, grouping) plus `loadLauncher` which fetches two endpoints from the main server with the gateway's environment credentials. `launcher-html.ts` renders the page as a single HTML document with inline CSS and no JavaScript. `gateway.ts` gains one branch: after the existing credential check, `/m` and `/m/` are answered locally instead of proxied.

**Tech Stack:** TypeScript, `node:http`, `bun:test`, no new dependencies.

## Global Constraints

- Package path: `packages/mobile-gateway`. No new runtime dependencies.
- Relative imports in `src/` carry explicit `.ts` extensions (Node's native loader requires this).
- Tests run with `bun test` from `packages/mobile-gateway`; never from the repo root.
- Typecheck with `bun typecheck` (`tsgo --noEmit`) from the package directory. Never invoke `tsc`.
- No `export namespace`, no import aliases, no star imports, no `any` in exported signatures, no comments unless a constraint is non-obvious.
- Conventional commit messages.
- The launcher is served **only** to requests that already passed the gateway's existing credential check. No second auth path.
- The launcher is never proxied upstream. `/m` and `/m/` are answered locally.
- Upstream calls from the launcher use the gateway's environment credentials (`envAuthHeader`) and a 5-second `AbortSignal.timeout`, matching `src/upstream.ts:47`.
- Every interpolated value in rendered HTML is escaped. Session titles are model- and user-influenced text.
- The page contains **no JavaScript**. Every interaction is a plain anchor navigation; no `<script>` tag may appear in the rendered output. `test/launcher-html.test.ts` asserts this.
- Upstream paths are built with `upstreamUrl(base, "http://gateway/<path>")`, the same pattern `src/upstream.ts:44` uses, so a configured base path prefix is honored.
- Deep-link slugs must match `base64Encode` in `packages/core/src/util/encode.ts`: standard base64 with `+`→`-`, `/`→`_`, padding stripped.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/mobile-gateway/src/launcher.ts` | Pure helpers (`sessionSlug`, `projectLabel`, `relativeTime`, `groupSessions`) and `loadLauncher` data fetching |
| `packages/mobile-gateway/src/launcher-html.ts` | `escapeHtml`, `renderLauncher`, `renderUnreachable` |
| `packages/mobile-gateway/src/gateway.ts` | Add the `/m` route branch after the credential check |
| `packages/mobile-gateway/test/launcher.test.ts` | Unit tests for helpers and loading |
| `packages/mobile-gateway/test/launcher-html.test.ts` | Unit tests for rendering and escaping |
| `packages/mobile-gateway/test/gateway.test.ts` | Integration tests for the `/m` route |
| `packages/mobile-gateway/README.md` | Document the launcher |

---

### Task 1: Launcher helpers

**Files:**
- Create: `packages/mobile-gateway/src/launcher.ts`
- Test: `packages/mobile-gateway/test/launcher.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type LauncherSession = { id: string; title: string; directory: string | undefined; updated: number }`
  - `type LauncherGroup = { directory: string; label: string; sessions: LauncherSession[] }`
  - `type LauncherData = { running: LauncherSession[]; groups: LauncherGroup[] }`
  - `sessionSlug(directory: string): string`
  - `projectLabel(directory: string | undefined): string`
  - `relativeTime(updated: number, now: number): string`
  - `groupSessions(input: { sessions: LauncherSession[]; running: string[] }): LauncherData`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/launcher.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { groupSessions, projectLabel, relativeTime, sessionSlug } from "../src/launcher.ts"

const session = (id: string, directory: string | undefined, updated: number, title = id) => ({
  id,
  title,
  directory,
  updated,
})

describe("sessionSlug", () => {
  test("matches the app's URL-safe base64 encoding", () => {
    expect(sessionSlug("/home/yeager1977/GitHub/flynncode")).toBe("L2hvbWUveWVhZ2VyMTk3Ny9HaXRIdWIvZmx5bm5jb2Rl")
  })

  test("encodes the root directory without padding", () => {
    expect(sessionSlug("/")).toBe("Lw")
  })

  test("produces url-safe characters only", () => {
    expect(sessionSlug("/tmp/a+b?c/d")).not.toMatch(/[+/=]/)
  })
})

describe("projectLabel", () => {
  test("uses the final path segment", () => {
    expect(projectLabel("/home/yeager1977/GitHub/flynncode")).toBe("flynncode")
  })

  test("renders the root directory as a slash", () => {
    expect(projectLabel("/")).toBe("/")
  })

  test("ignores trailing slashes", () => {
    expect(projectLabel("/home/yeager1977/GitHub/flynncode/")).toBe("flynncode")
  })

  test("names a missing directory", () => {
    expect(projectLabel(undefined)).toBe("Unknown project")
  })
})

describe("relativeTime", () => {
  const now = 1_700_000_000_000

  test("describes recent updates", () => {
    expect(relativeTime(now - 5_000, now)).toBe("just now")
    expect(relativeTime(now - 12 * 60_000, now)).toBe("12m ago")
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago")
  })

  test("never reports a negative age", () => {
    expect(relativeTime(now + 60_000, now)).toBe("just now")
  })
})

describe("groupSessions", () => {
  test("groups sessions by directory, newest group first", () => {
    const data = groupSessions({
      sessions: [
        session("s1", "/a", 100),
        session("s2", "/b", 300),
        session("s3", "/a", 200),
      ],
      running: [],
    })
    expect(data.groups.map((group) => group.directory)).toEqual(["/b", "/a"])
    expect(data.groups[0].label).toBe("b")
    expect(data.groups[1].sessions.map((item) => item.id)).toEqual(["s3", "s1"])
  })

  test("orders sessions inside a group newest first", () => {
    const data = groupSessions({
      sessions: [session("old", "/a", 100), session("new", "/a", 500)],
      running: [],
    })
    expect(data.groups[0].sessions.map((item) => item.id)).toEqual(["new", "old"])
  })

  test("separates running sessions from recent ones", () => {
    const data = groupSessions({
      sessions: [session("s1", "/a", 100), session("s2", "/a", 200)],
      running: ["s1"],
    })
    expect(data.running.map((item) => item.id)).toEqual(["s1"])
    expect(data.groups[0].sessions.map((item) => item.id)).toEqual(["s2"])
  })

  test("includes a running session missing from the recent list", () => {
    const data = groupSessions({ sessions: [], running: ["ses_abcdef123456"] })
    expect(data.running).toHaveLength(1)
    expect(data.running[0].directory).toBeUndefined()
    expect(data.running[0].title).toBe("ses_abcdef12")
  })

  test("places sessions without a directory last", () => {
    const data = groupSessions({
      sessions: [session("s1", undefined, 999), session("s2", "/a", 1)],
      running: [],
    })
    expect(data.groups.map((group) => group.directory)).toEqual(["/a", ""])
    expect(data.groups[1].label).toBe("Unknown project")
  })

  test("returns empty results for no sessions", () => {
    const data = groupSessions({ sessions: [], running: [] })
    expect(data).toEqual({ running: [], groups: [] })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/launcher.test.ts` from `packages/mobile-gateway`
Expected: FAIL, cannot resolve `../src/launcher.ts`.

- [ ] **Step 3: Implement the helpers**

Create `packages/mobile-gateway/src/launcher.ts` with the pure helpers only (data loading arrives in Task 2):

```ts
export type LauncherSession = {
  id: string
  title: string
  directory: string | undefined
  updated: number
}

export type LauncherGroup = {
  directory: string
  label: string
  sessions: LauncherSession[]
}

export type LauncherData = {
  running: LauncherSession[]
  groups: LauncherGroup[]
}

const UNKNOWN_PROJECT = "Unknown project"
const PLACEHOLDER_TITLE_LENGTH = 12

export function sessionSlug(directory: string) {
  const bytes = new TextEncoder().encode(directory)
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function projectLabel(directory: string | undefined) {
  if (directory === undefined) return UNKNOWN_PROJECT
  if (directory === "/") return "/"
  const trimmed = directory.replace(/\/+$/, "")
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  return segment || directory
}

export function relativeTime(updated: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - updated) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function groupSessions(input: { sessions: LauncherSession[]; running: string[] }): LauncherData {
  const active = new Set(input.running)
  const known = new Map(input.sessions.map((session) => [session.id, session]))
  const running = input.running.map((id) => known.get(id) ?? placeholder(id))
  const byDirectory = new Map<string, LauncherGroup>()

  for (const session of input.sessions) {
    if (active.has(session.id)) continue
    const key = session.directory ?? ""
    const group = byDirectory.get(key)
    if (group) {
      group.sessions.push(session)
      continue
    }
    byDirectory.set(key, { directory: key, label: projectLabel(session.directory), sessions: [session] })
  }

  const groups = [...byDirectory.values()].map((group) => ({
    ...group,
    sessions: [...group.sessions].sort((a, b) => b.updated - a.updated),
  }))

  groups.sort((a, b) => {
    if (a.directory === "") return 1
    if (b.directory === "") return -1
    return newest(b.sessions) - newest(a.sessions)
  })

  return { running, groups }
}

function newest(sessions: LauncherSession[]) {
  return sessions.reduce((max, session) => (session.updated > max ? session.updated : max), 0)
}

function placeholder(id: string) {
  return {
    id,
    title: id.slice(0, PLACEHOLDER_TITLE_LENGTH),
    directory: undefined,
    updated: 0,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/launcher.test.ts` from `packages/mobile-gateway`
Expected: PASS, 15 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/launcher.ts packages/mobile-gateway/test/launcher.test.ts
git commit -m "feat(mobile-gateway): add launcher grouping helpers"
```

---

### Task 2: Launcher data loading

**Files:**
- Modify: `packages/mobile-gateway/src/launcher.ts`
- Test: `packages/mobile-gateway/test/launcher.test.ts`

**Interfaces:**
- Consumes: `sessionSlug`, `groupSessions`, and the types from Task 1; `upstreamUrl` from `src/upstream.ts`.
- Produces:
  - `type LauncherLoad = { kind: "loaded"; data: LauncherData; partial: boolean } | { kind: "unreachable" }`
  - `loadLauncher(input: { upstream: string; authorization: string }): Promise<LauncherLoad>`

Behavior: fetches `GET {upstream}/api/session/active` and `GET {upstream}/api/session?limit=30&order=desc` concurrently with the environment `authorization`, a 5-second timeout, and no redirects followed. If both fail the result is `unreachable`. If exactly one fails the result is `loaded` with `partial: true` and the successful data used. Session fields are parsed defensively; malformed entries are dropped rather than throwing.

- [ ] **Step 1: Write the failing test**

Append to `packages/mobile-gateway/test/launcher.test.ts`:

```ts
import { loadLauncher } from "../src/launcher.ts"

const upstreamWith = (fetch: (request: Request) => Response | Promise<Response>) =>
  Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })

const AUTH = `Basic ${Buffer.from("opencode:secret").toString("base64")}`

describe("loadLauncher", () => {
  test("loads running and recent sessions", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (request.headers.get("authorization") !== AUTH) return new Response("no", { status: 401 })
      if (path === "/api/session/active") return Response.json({ data: { ses_1: { type: "running" } } })
      if (path === "/api/session") {
        return Response.json({
          data: [
            {
              id: "ses_1",
              title: "Running one",
              location: { directory: "/work/a" },
              time: { updated: 500 },
            },
            {
              id: "ses_2",
              title: "Recent one",
              location: { directory: "/work/a" },
              time: { updated: 400 },
            },
          ],
        })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") return
    expect(result.partial).toBe(false)
    expect(result.data.running.map((item) => item.id)).toEqual(["ses_1"])
    expect(result.data.groups[0].sessions.map((item) => item.id)).toEqual(["ses_2"])
  })

  test("sends the limit and order query the endpoint expects", async () => {
    const seen: string[] = []
    const upstream = upstreamWith((request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/session") {
        seen.push(url.search)
        return Response.json({ data: [] })
      }
      return Response.json({ data: {} })
    })

    await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(seen).toEqual(["?limit=30&order=desc"])
  })

  test("reports unreachable when both calls fail", async () => {
    const result = await loadLauncher({ upstream: "http://127.0.0.1:1", authorization: AUTH })
    expect(result).toEqual({ kind: "unreachable" })
  })

  test("reports partial when one call fails", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/session/active") return new Response("boom", { status: 500 })
      return Response.json({ data: [] })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") return
    expect(result.partial).toBe(true)
  })

  test("drops malformed session entries without throwing", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/session") {
        return Response.json({
          data: [null, 42, { title: "no id" }, { id: "ok", time: { updated: "nope" } }],
        })
      }
      return Response.json({ data: {} })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") return
    expect(result.data.groups[0].sessions).toHaveLength(1)
    expect(result.data.groups[0].sessions[0].id).toBe("ok")
    expect(result.data.groups[0].sessions[0].updated).toBe(0)
    expect(result.data.groups[0].sessions[0].title).toBe("ok")
  })

  test("does not follow redirects", async () => {
    const upstream = upstreamWith(() => new Response(null, { status: 302, headers: { location: "http://elsewhere" } }))
    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)
    expect(result).toEqual({ kind: "unreachable" })
  })

  test("honors a base path prefix on the upstream", async () => {
    const seen: string[] = []
    const upstream = upstreamWith((request) => {
      const url = new URL(request.url)
      seen.push(url.pathname)
      if (url.pathname.endsWith("/api/session/active")) return Response.json({ data: {} })
      return Response.json({ data: [] })
    })

    await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}/base`, authorization: AUTH })
    upstream.stop(true)

    expect(seen).toEqual(["/base/api/session/active", "/base/api/session"])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/launcher.test.ts` from `packages/mobile-gateway`
Expected: FAIL, `loadLauncher` is not exported.

- [ ] **Step 3: Implement `loadLauncher`**

Append to `packages/mobile-gateway/src/launcher.ts`:

```ts
import { upstreamUrl } from "./upstream.ts"

const TIMEOUT_MS = 5000
const RECENT_LIMIT = 30

export type LauncherLoad =
  | { kind: "loaded"; data: LauncherData; partial: boolean }
  | { kind: "unreachable" }

export async function loadLauncher(input: { upstream: string; authorization: string }): Promise<LauncherLoad> {
  const [active, recent] = await Promise.all([
    request(input, "http://gateway/api/session/active"),
    request(input, `http://gateway/api/session?limit=${RECENT_LIMIT}&order=desc`),
  ])

  if (active === undefined && recent === undefined) return { kind: "unreachable" }

  return {
    kind: "loaded",
    partial: active === undefined || recent === undefined,
    data: groupSessions({ sessions: parseSessions(recent), running: parseActive(active) }),
  }
}

async function request(input: { upstream: string; authorization: string }, url: string) {
  try {
    const response = await fetch(upstreamUrl(input.upstream, url), {
      headers: { authorization: input.authorization },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return
    return (await response.json()) as unknown
  } catch {
    return
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseActive(value: unknown) {
  if (!isRecord(value) || !isRecord(value.data)) return []
  return Object.keys(value.data)
}

function parseSessions(value: unknown): LauncherSession[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  const sessions: LauncherSession[] = []
  for (const item of value.data) {
    if (!isRecord(item)) continue
    if (typeof item.id !== "string" || !item.id) continue
    const location = isRecord(item.location) ? item.location : undefined
    const time = isRecord(item.time) ? item.time : undefined
    sessions.push({
      id: item.id,
      title: typeof item.title === "string" && item.title.trim() ? item.title : item.id,
      directory: location && typeof location.directory === "string" ? location.directory : undefined,
      updated: time && typeof time.updated === "number" && Number.isFinite(time.updated) ? time.updated : 0,
    })
  }
  return sessions
}
```

Import placement note: the repo style keeps imports at the top of the file. Move the `import { upstreamUrl } from "./upstream.ts"` line to the top of `launcher.ts` above the type declarations rather than leaving it mid-file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/launcher.test.ts` from `packages/mobile-gateway`
Expected: PASS, 22 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/launcher.ts packages/mobile-gateway/test/launcher.test.ts
git commit -m "feat(mobile-gateway): load running and recent sessions for the launcher"
```

---

### Task 3: Launcher HTML rendering

**Files:**
- Create: `packages/mobile-gateway/src/launcher-html.ts`
- Test: `packages/mobile-gateway/test/launcher-html.test.ts`

**Interfaces:**
- Consumes: `LauncherData`, `LauncherSession`, `projectLabel`, `relativeTime`, `sessionSlug` from `src/launcher.ts`.
- Produces:
  - `escapeHtml(value: string): string`
  - `renderLauncher(input: { data: LauncherData; now: number; partial: boolean }): string`
  - `renderUnreachable(): string`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/launcher-html.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { escapeHtml, renderLauncher, renderUnreachable } from "../src/launcher-html.ts"

const NOW = 1_700_000_000_000

const data = (overrides: Partial<{ running: never[]; groups: never[] }> = {}) => ({
  running: [],
  groups: [],
  ...overrides,
})

describe("escapeHtml", () => {
  test("escapes markup characters", () => {
    expect(escapeHtml(`<script>alert("x")&'y'</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;",
    )
  })
})

describe("renderLauncher", () => {
  test("renders a session as a deep link with an escaped title", () => {
    const html = renderLauncher({
      now: NOW,
      partial: false,
      data: {
        running: [],
        groups: [
          {
            directory: "/work/flynncode",
            label: "flynncode",
            sessions: [
              { id: "ses_1", title: "<img src=x onerror=alert(1)>", directory: "/work/flynncode", updated: NOW - 60_000 },
            ],
          },
        ],
      },
    })
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain(`/L3dvcmsvZmx5bm5jb2Rl/session/ses_1`)
    expect(html).toContain("1m ago")
    expect(html).toContain("flynncode")
  })

  test("marks running sessions and excludes them from groups", () => {
    const html = renderLauncher({
      now: NOW,
      partial: false,
      data: {
        running: [
          { id: "ses_run", title: "Working", directory: "/work/a", updated: NOW - 1_000 },
        ],
        groups: [],
      },
    })
    expect(html).toContain("Running now")
    expect(html).toContain("Working")
    expect(html).toContain("just now")
  })

  test("states when nothing is running", () => {
    const html = renderLauncher({ now: NOW, partial: false, data: data() })
    expect(html).toContain("Nothing is running")
  })

  test("states when there are no recent sessions", () => {
    const html = renderLauncher({ now: NOW, partial: false, data: data() })
    expect(html).toContain("No recent sessions")
  })

  test("renders a session without a directory as text, not a link", () => {
    const html = renderLauncher({
      now: NOW,
      partial: false,
      data: {
        running: [{ id: "ses_orphan123", title: "ses_orphan12", directory: undefined, updated: 0 }],
        groups: [],
      },
    })
    expect(html).toContain("ses_orphan12")
    expect(html).not.toContain("/session/ses_orphan123")
  })

  test("warns when data is partial", () => {
    const html = renderLauncher({ now: NOW, partial: true, data: data() })
    expect(html).toContain("Some session data is unavailable")
  })

  test("omits the warning when data is complete", () => {
    const html = renderLauncher({ now: NOW, partial: false, data: data() })
    expect(html).not.toContain("Some session data is unavailable")
  })

  test("declares mobile install metadata and no scripts", () => {
    const html = renderLauncher({ now: NOW, partial: false, data: data() })
    expect(html).toContain("apple-mobile-web-app-capable")
    expect(html).toContain("viewport-fit=cover")
    expect(html).toContain("safe-area-inset-bottom")
    expect(html).not.toContain("<script")
  })
})

describe("renderUnreachable", () => {
  test("explains the server is unreachable and offers a reload", () => {
    const html = renderUnreachable()
    expect(html).toContain("unreachable")
    expect(html).toContain('href="/m"')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/launcher-html.test.ts` from `packages/mobile-gateway`
Expected: FAIL, cannot resolve `../src/launcher-html.ts`.

- [ ] **Step 3: Implement the renderer**

Create `packages/mobile-gateway/src/launcher-html.ts`:

```ts
import { projectLabel, relativeTime, sessionSlug, type LauncherData, type LauncherSession } from "./launcher.ts"

const RUNNING_BADGE = "running"

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function row(session: LauncherSession, now: number, running: boolean) {
  const title = `<span class="title">${escapeHtml(session.title)}</span>`
  const meta = `<span class="meta">${escapeHtml(projectLabel(session.directory))} &middot; ${escapeHtml(relativeTime(session.updated, now))}${running ? ` &middot; ${RUNNING_BADGE}` : ""}</span>`
  if (session.directory === undefined) return `<div class="row">${title}${meta}</div>`
  const href = `/${sessionSlug(session.directory)}/session/${encodeURIComponent(session.id)}`
  return `<a class="row" href="${escapeHtml(href)}">${title}${meta}</a>`
}

function section(heading: string, rows: string[]) {
  return `<section><h2>${escapeHtml(heading)}</h2>${rows.join("")}</section>`
}

export function renderLauncher(input: { data: LauncherData; now: number; partial: boolean }) {
  const running = input.data.running.length
    ? section("Running now", input.data.running.map((session) => row(session, input.now, true)))
    : `<p class="quiet">Nothing is running.</p>`

  const groups = input.data.groups.length
    ? input.data.groups
        .map((group) => section(group.label, group.sessions.map((session) => row(session, input.now, false))))
        .join("")
    : `<p class="quiet">No recent sessions.</p>`

  const warning = input.partial ? `<p class="warn">Some session data is unavailable.</p>` : ""

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Sessions</title>
<style>
${STYLE}
</style>
</head>
<body>
<h1>Sessions</h1>
${warning}
${running}
${groups}
</body>
</html>`
}

export function renderUnreachable() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Sessions</title>
<style>
${STYLE}
</style>
</head>
<body>
<h1>Sessions</h1>
<p class="warn">The opencode server is unreachable.</p>
<p><a class="row" href="/m">Reload</a></p>
</body>
</html>`
}

const STYLE = `:root { color-scheme: light dark }
* { box-sizing: border-box }
body {
  margin: 0;
  font: 17px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #fafafa;
  color: #111;
  padding: max(env(safe-area-inset-top), 12px) 16px max(env(safe-area-inset-bottom), 24px) 16px;
}
h1 { font-size: 22px; margin: 8px 0 20px }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #666; margin: 24px 0 8px }
.row {
  display: block;
  min-height: 44px;
  padding: 14px 12px;
  margin-bottom: 8px;
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  background: #fff;
  color: inherit;
  text-decoration: none;
}
.title { display: block; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.meta { display: block; font-size: 13px; color: #777; margin-top: 4px }
.quiet { color: #777; font-size: 15px }
.warn { background: #fff3cd; color: #664d03; padding: 10px 12px; border-radius: 10px; font-size: 14px }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #eee }
  .row { background: #1c1c1c; border-color: #333 }
  .meta, .quiet { color: #999 }
  h2 { color: #999 }
  .warn { background: #3a2f00; color: #ffd76e }
}`
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/launcher-html.test.ts` from `packages/mobile-gateway`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/launcher-html.ts packages/mobile-gateway/test/launcher-html.test.ts
git commit -m "feat(mobile-gateway): render the launcher page"
```

---

### Task 4: Gateway route integration

**Files:**
- Modify: `packages/mobile-gateway/src/gateway.ts`
- Test: `packages/mobile-gateway/test/gateway.test.ts`

**Interfaces:**
- Consumes: `loadLauncher` from `src/launcher.ts`; `renderLauncher`, `renderUnreachable` from `src/launcher-html.ts`.
- Produces: no new exports. `/m` and `/m/` are answered locally; every other path behaves exactly as before.

The branch goes **after** the credential check and **before** the proxy target is built, so the launcher shares the existing auth path and its session cookie.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mobile-gateway/test/gateway.test.ts`:

```ts
describe("launcher route", () => {
  const withUpstream = async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        if (request.headers.get("authorization") !== basic("opencode", "secret")) {
          return new Response("unauthorized", { status: 401 })
        }
        if (path === "/api/session/active") return Response.json({ data: {} })
        if (path === "/api/session") {
          return Response.json({
            data: [
              { id: "ses_launcher1", title: "Launcher target", location: { directory: "/work/a" }, time: { updated: 1000 } },
            ],
          })
        }
        return new Response("proxied", { status: 200 })
      },
    })
    const running = await startGateway({
      options: {
        host: "127.0.0.1",
        port: 0,
        upstream: `http://127.0.0.1:${upstream.port}`,
        username: "opencode",
        password: "secret",
        upstreamPassword: "secret",
      },
    })
    return { upstream, running }
  }

  test("requires credentials", async () => {
    const { upstream, running } = await withUpstream()
    const response = await fetch(`http://127.0.0.1:${running.port}/m`)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Basic")
    stopGateway()
    upstream.stop(true)
  })

  test("serves the page for an authenticated request and issues a session cookie", async () => {
    const { upstream, running } = await withUpstream()
    const response = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    const html = await response.text()
    expect(html).toContain("Launcher target")
    expect(html).toContain("/L3dvcmsvYQ/session/ses_launcher1")
    expect(response.headers.getSetCookie()[0]).toContain("oc_mobile_session=")
    stopGateway()
    upstream.stop(true)
  })

  test("treats /m/ the same as /m", async () => {
    const { upstream, running } = await withUpstream()
    const response = await fetch(`http://127.0.0.1:${running.port}/m/`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Sessions")
    stopGateway()
    upstream.stop(true)
  })

  test("serves the page for a valid session cookie without contacting the upstream for auth", async () => {
    const { upstream, running } = await withUpstream()
    const first = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    const response = await fetch(`http://127.0.0.1:${running.port}/m`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Launcher target")
    stopGateway()
    upstream.stop(true)
  })

  test("renders the unreachable page for a cookie holder when the upstream is down", async () => {
    const { upstream, running } = await withUpstream()
    // Establish a session while the upstream is healthy, then take the upstream away.
    const first = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(first.status).toBe(200)
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    upstream.stop(true)

    const response = await fetch(`http://127.0.0.1:${running.port}/m`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain("unreachable")
    expect(html).toContain('href="/m"')
    stopGateway()
  })

  test("rejects a first-time visitor with 503 when the upstream is down", async () => {
    // Without a session cookie the credential probe cannot succeed, so the request
    // never reaches the launcher. The distinct 503 (rather than 401) tells the user
    // the server is down rather than that their password is wrong.
    const running = await startGateway({
      options: {
        host: "127.0.0.1",
        port: 0,
        upstream: "http://127.0.0.1:1",
        username: "opencode",
        password: "secret",
        upstreamPassword: "secret",
      },
    })
    const response = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(response.status).toBe(503)
    expect(response.headers.get("www-authenticate")).toBeNull()
    stopGateway()
  })

  test("still proxies other paths", async () => {
    const { upstream, running } = await withUpstream()
    const first = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    const response = await fetch(`http://127.0.0.1:${running.port}/api/health`, { headers: { cookie } })
    expect(await response.text()).toBe("proxied")
    stopGateway()
    upstream.stop(true)
  })

  test("does not proxy the launcher path upstream", async () => {
    const paths: string[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        paths.push(path)
        if (path === "/api/session/active") return Response.json({ data: {} })
        if (path === "/api/session") return Response.json({ data: [] })
        return new Response("proxied")
      },
    })
    const running = await startGateway({
      options: {
        host: "127.0.0.1",
        port: 0,
        upstream: `http://127.0.0.1:${upstream.port}`,
        username: "opencode",
        password: "secret",
        upstreamPassword: "secret",
      },
    })
    await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(paths).not.toContain("/m")
    stopGateway()
    upstream.stop(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/gateway.test.ts` from `packages/mobile-gateway`
Expected: FAIL. `/m` currently proxies upstream, so the credentials-required and page-content tests fail.

- [ ] **Step 3: Implement the branch**

In `packages/mobile-gateway/src/gateway.ts`, add the imports at the top:

```ts
import { loadLauncher } from "./launcher.ts"
import { renderLauncher, renderUnreachable } from "./launcher-html.ts"
```

Add a path predicate near `decodeBasic`:

```ts
function isLauncherPath(url: string) {
  const pathname = new URL(url, "http://localhost").pathname
  return pathname === "/m" || pathname === "/m/"
}
```

Then, inside the returned `handle` function, insert the branch immediately after the credential block and before `const target = upstreamUrl(...)`:

```ts
    if (isLauncherPath(request.url)) {
      const loaded = await loadLauncher({ upstream: options.upstream, authorization })
      const page =
        loaded.kind === "unreachable"
          ? renderUnreachable()
          : renderLauncher({ data: loaded.data, now: Date.now(), partial: loaded.partial })
      const response = new Response(page, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
      if (issued !== undefined) response.headers.set("set-cookie", sessionCookie(issued))
      return response
    }
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `bun test` from `packages/mobile-gateway`
Expected: PASS. All previously passing tests plus 8 new launcher-route tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/gateway.ts packages/mobile-gateway/test/gateway.test.ts
git commit -m "feat(mobile-gateway): serve the session launcher at /m"
```

---

### Task 5: Documentation and phone verification

**Files:**
- Modify: `packages/mobile-gateway/README.md`
- Modify: `docs/superpowers/specs/2026-09-15-mobile-launcher-design.md` (only if implementation diverged)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation, and a recorded manual verification at iPhone viewport.

- [ ] **Step 1: Document the launcher**

Add a section to `packages/mobile-gateway/README.md`, placed after the phone instructions. Content:

- The launcher lives at `http://<lan-ip>:4097/m` and requires the same phone credential.
- It lists running sessions first, then recent sessions grouped by project.
- Tapping a row opens that session in the full app.
- Add `/m` to the home screen instead of `/` for the two-tap flow.
- It shows the most recent 30 sessions; older sessions are still reachable through the app's own project picker.
- If the gateway reports the server as unreachable, the page says so with a reload link.

- [ ] **Step 2: Verify at iPhone viewport against a live gateway**

Requires the desktop app running so the gateway is live with a real upstream. Use the verification technique already proven in this repo: Playwright with a device profile, pointed at the gateway with `http.setHTTPCredentials`.

Write a temporary script (do not commit it) that:

1. Launches Chromium with `devices["iPhone 14 Pro"]`.
2. Sets HTTP credentials to the phone password.
3. Navigates to `http://127.0.0.1:4097/m`.
4. Asserts: the page contains a "Running now" or "Nothing is running" line; at least one project heading with sessions appears; `document.documentElement.scrollWidth <= window.innerWidth` (no horizontal scroll).
5. Clicks the first session row and asserts the URL changed to a `/<slug>/session/<id>` path and the app's composer or message timeline rendered.
6. Screenshots both views for the record.

Report the actual assertions and the screenshot paths. If the live gateway is not running, start it from the repo with `OPENCODE_MOBILE_PASSWORD` set and `OPENCODE_MOBILE_UPSTREAM` pointed at the desktop server's current port, then verify; state clearly in the report which upstream was used.

- [ ] **Step 3: Run the full suite, typecheck and lint**

```bash
cd packages/mobile-gateway && bun test && bun typecheck
cd ../.. && bunx oxlint packages/mobile-gateway
```

Expected: all tests pass, typecheck clean, zero oxlint errors in the package.

- [ ] **Step 4: Commit**

```bash
git add packages/mobile-gateway/README.md
git commit -m "docs(mobile-gateway): document the session launcher"
```

---

## Verification

Automated:

- `bun test` from `packages/mobile-gateway` — all tests pass, including the 7 launcher-route integration tests.
- `bun typecheck` from `packages/mobile-gateway` — clean.
- `bunx oxlint packages/mobile-gateway` — zero errors.
- `grep -rn "Bun\." packages/mobile-gateway/src/` — no output (the package must keep running under Electron's Node).

Manual, on the phone:

- `http://<lan-ip>:4097/m` prompts once, then lists running and recent sessions.
- No horizontal scroll; text legible; rows comfortably tappable one-handed.
- Tapping a row opens that session in the real app.
- Adding `/m` to the home screen launches standalone.
- With the desktop app closed, `/m` reports the server unreachable and offers a reload.
