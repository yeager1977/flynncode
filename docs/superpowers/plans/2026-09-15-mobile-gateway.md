# Mobile Gateway Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach the running opencode server's sessions from an iPhone on the same LAN, with read, prompt, abort, and permission/question handling.

**Architecture:** A new `packages/mobile-gateway` package exposing a LAN-bound reverse proxy that forwards to the local opencode server with upstream Basic auth injected. It ships as both an opencode plugin (`exports["./server"]`, starts on plugin init, closes via `Hooks.dispose`) and a standalone bin (for headless `opencode serve`, where plugins load lazily). The phone gets the existing web app at the gateway origin, so the app auto-targets the gateway as its backend.

**Tech Stack:** TypeScript, Bun (`Bun.serve`), `bun:test`, `@opencode-ai/plugin` types. No new runtime dependencies.

## Global Constraints

- Package name `@flynncode/mobile-gateway`, binary `flynncode-mobile`. Package path `packages/mobile-gateway`; it is picked up by the root `workspaces.packages` glob (`packages/*`) with no root config change.
- Default listen port `4097`; override `OPENCODE_MOBILE_PORT`. Port `0` binds ephemeral and logs the chosen port.
- Bind `0.0.0.0` by default; override `OPENCODE_MOBILE_HOST`.
- Gateway must refuse to bind unless `OPENCODE_SERVER_PASSWORD` is non-empty, and must log the reason.
- Upstream URL default `http://127.0.0.1:4096`; override `OPENCODE_MOBILE_UPSTREAM`. Normalize trailing slashes.
- Upstream credentials always come from the gateway environment: username `OPENCODE_SERVER_USERNAME` (default `opencode`), password `OPENCODE_SERVER_PASSWORD`.
- Session cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=2592000`. Tokens in memory only; lost on restart.
- Cookie name `oc_mobile_session`.
- A request reaches upstream only when it presents a valid session cookie, or presents Basic credentials that match the gateway's own environment. Anything else is rejected with 401 before any upstream call.
- Proxy must strip `content-encoding`, `content-length`, and `transfer-encoding` from forwarded responses (matches `packages/opencode/src/server/shared/ui.ts:30-38`).
- SSE streams must be forwarded unbuffered, including `cache-control: no-cache, no-transform` and `x-accel-buffering: no` when upstream sends them.
- No new runtime dependencies. Dev deps only, from catalog: `@tsconfig/bun`, `@types/bun`, `@typescript/native-preview`, `typescript`.
- Use `bun test` from the package directory; never run tests from repo root.
- Use `bun typecheck` (`tsgo --noEmit`) from the package directory.
- No `export namespace`. No import aliases, no star imports. No `any`.
- No comments unless a constraint is non-obvious.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/mobile-gateway/package.json` | Package metadata, exports (`.`, `./server`), bin, scripts, engines |
| `packages/mobile-gateway/tsconfig.json` | Typecheck config extending `@tsconfig/bun` |
| `packages/mobile-gateway/src/config.ts` | Env → validated `GatewayOptions`; env-var credential helper |
| `packages/mobile-gateway/src/session.ts` | In-memory token store: issue, verify |
| `packages/mobile-gateway/src/cookies.ts` | Parse `Cookie` header, serialize `Set-Cookie` |
| `packages/mobile-gateway/src/upstream.ts` | Upstream URL resolution, auth headers, `Upstream.probe` |
| `packages/mobile-gateway/src/proxy.ts` | Request/response header transformation |
| `packages/mobile-gateway/src/gateway.ts` | `Bun.serve` wiring, auth decision, reference-counted start/stop |
| `packages/mobile-gateway/src/index.ts` | Plugin entry: default export `{ id, server }` |
| `packages/mobile-gateway/src/bin.ts` | Standalone CLI entry with signal handling |
| `packages/mobile-gateway/test/config.test.ts` | Config resolution and validation |
| `packages/mobile-gateway/test/session.test.ts` | Token issue/verify |
| `packages/mobile-gateway/test/cookies.test.ts` | Cookie parse/serialize |
| `packages/mobile-gateway/test/proxy.test.ts` | Header transformation and SSE pass-through |
| `packages/mobile-gateway/test/gateway.test.ts` | End-to-end auth + proxy against a real upstream |
| `packages/mobile-gateway/test/plugin.test.ts` | Plugin entry starts and disposes cleanly |

---

### Task 1: Package scaffold and configuration

**Files:**
- Create: `packages/mobile-gateway/package.json`
- Create: `packages/mobile-gateway/tsconfig.json`
- Create: `packages/mobile-gateway/src/config.ts`
- Test: `packages/mobile-gateway/test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type GatewayOptions = { host: string; port: number; upstream: string; username: string; password: string }`
  - `resolveOptions(env: Record<string, string | undefined>): { ok: true; value: GatewayOptions } | { ok: false; reason: string }`
  - `envAuthHeader(options: GatewayOptions): string` returning `Basic base64(username:password)`

- [ ] **Step 1: Create `package.json`**

```json
{
  "$schema": "https://json.schemastore.org/package.json",
  "name": "@flynncode/mobile-gateway",
  "version": "0.1.0",
  "description": "LAN gateway for reaching opencode sessions from a phone",
  "type": "module",
  "license": "MIT",
  "bin": {
    "flynncode-mobile": "./src/bin.ts"
  },
  "exports": {
    ".": "./src/config.ts",
    "./server": "./src/index.ts"
  },
  "files": [
    "src"
  ],
  "engines": {
    "opencode": ">=1.18.0"
  },
  "scripts": {
    "test": "bun test --timeout 30000",
    "typecheck": "tsgo --noEmit"
  },
  "devDependencies": {
    "@tsconfig/bun": "catalog:",
    "@types/bun": "catalog:",
    "@typescript/native-preview": "catalog:",
    "typescript": "catalog:"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@tsconfig/bun/tsconfig.json",
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["bun"],
    "noUncheckedIndexedAccess": false
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Install so the workspace links**

Run: `bun install`
Expected: `bun.lock` updated, `packages/mobile-gateway/node_modules` created.

- [ ] **Step 4: Write the failing config test**

Create `packages/mobile-gateway/test/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { envAuthHeader, resolveOptions } from "../src/config"

const base = {
  OPENCODE_SERVER_PASSWORD: "secret",
}

describe("resolveOptions", () => {
  test("applies defaults", () => {
    const result = resolveOptions(base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.host).toBe("0.0.0.0")
    expect(result.value.port).toBe(4097)
    expect(result.value.upstream).toBe("http://127.0.0.1:4096")
    expect(result.value.username).toBe("opencode")
    expect(result.value.password).toBe("secret")
  })

  test("reads overrides", () => {
    const result = resolveOptions({
      ...base,
      OPENCODE_MOBILE_HOST: "127.0.0.1",
      OPENCODE_MOBILE_PORT: "5100",
      OPENCODE_MOBILE_UPSTREAM: "http://127.0.0.1:8080/",
      OPENCODE_SERVER_USERNAME: "someone",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.host).toBe("127.0.0.1")
    expect(result.value.port).toBe(5100)
    expect(result.value.upstream).toBe("http://127.0.0.1:8080")
    expect(result.value.username).toBe("someone")
  })

  test("accepts port 0 as ephemeral", () => {
    const result = resolveOptions({ ...base, OPENCODE_MOBILE_PORT: "0" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.port).toBe(0)
  })

  test("rejects a missing or empty password", () => {
    expect(resolveOptions({}).ok).toBe(false)
    expect(resolveOptions({ OPENCODE_SERVER_PASSWORD: "" }).ok).toBe(false)
  })

  test("rejects a non-numeric port", () => {
    const result = resolveOptions({ ...base, OPENCODE_MOBILE_PORT: "abc" })
    expect(result.ok).toBe(false)
  })

  test("rejects an out-of-range port", () => {
    expect(resolveOptions({ ...base, OPENCODE_MOBILE_PORT: "70000" }).ok).toBe(false)
  })

  test("rejects an unparseable upstream", () => {
    expect(resolveOptions({ ...base, OPENCODE_MOBILE_UPSTREAM: "not a url" }).ok).toBe(false)
  })
})

describe("envAuthHeader", () => {
  test("encodes username and password", () => {
    const header = envAuthHeader({
      host: "0.0.0.0",
      port: 4097,
      upstream: "http://127.0.0.1:4096",
      username: "opencode",
      password: "secret",
    })
    expect(header).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `bun test test/config.test.ts` from `packages/mobile-gateway`
Expected: FAIL, cannot resolve `../src/config`.

- [ ] **Step 6: Implement `src/config.ts`**

```ts
export type GatewayOptions = {
  host: string
  port: number
  upstream: string
  username: string
  password: string
}

export type ResolveResult = { ok: true; value: GatewayOptions } | { ok: false; reason: string }

const DEFAULT_HOST = "0.0.0.0"
const DEFAULT_PORT = 4097
const DEFAULT_UPSTREAM = "http://127.0.0.1:4096"
const DEFAULT_USERNAME = "opencode"

function readPort(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65535) return "invalid"
  return value
}

function normalizeUpstream(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    return url.origin + url.pathname.replace(/\/+$/, "")
  } catch {
    return
  }
}

export function resolveOptions(env: Record<string, string | undefined>): ResolveResult {
  const password = env.OPENCODE_SERVER_PASSWORD ?? ""
  if (!password) {
    return { ok: false, reason: "OPENCODE_SERVER_PASSWORD must be set and non-empty to start the mobile gateway" }
  }

  const port = readPort(env.OPENCODE_MOBILE_PORT)
  if (port === "invalid") return { ok: false, reason: `OPENCODE_MOBILE_PORT is not a valid port` }

  const upstream = normalizeUpstream(env.OPENCODE_MOBILE_UPSTREAM ?? DEFAULT_UPSTREAM)
  if (!upstream) return { ok: false, reason: "OPENCODE_MOBILE_UPSTREAM is not a valid http(s) URL" }

  return {
    ok: true,
    value: {
      host: env.OPENCODE_MOBILE_HOST ?? DEFAULT_HOST,
      port: port ?? DEFAULT_PORT,
      upstream,
      username: env.OPENCODE_SERVER_USERNAME ?? DEFAULT_USERNAME,
      password,
    },
  }
}

export function envAuthHeader(options: GatewayOptions): string {
  return `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test test/config.test.ts` from `packages/mobile-gateway`
Expected: PASS, 8 tests.

- [ ] **Step 8: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/package.json packages/mobile-gateway/tsconfig.json packages/mobile-gateway/src/config.ts packages/mobile-gateway/test/config.test.ts bun.lock
git commit -m "feat(mobile-gateway): scaffold package and configuration"
```

---

### Task 2: Session token store

**Files:**
- Create: `packages/mobile-gateway/src/session.ts`
- Test: `packages/mobile-gateway/test/session.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SessionStore = { issue(): string; verify(token: string | undefined): boolean; size(): number }`
  - `createSessionStore(input?: { token?: () => string }): SessionStore` — `token` is injectable for tests

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/session.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { createSessionStore } from "../src/session"

describe("session store", () => {
  test("verifies an issued token", () => {
    const store = createSessionStore()
    const token = store.issue()
    expect(store.verify(token)).toBe(true)
  })

  test("rejects an unknown token", () => {
    const store = createSessionStore()
    store.issue()
    expect(store.verify("nope")).toBe(false)
  })

  test("rejects undefined and empty tokens", () => {
    const store = createSessionStore()
    expect(store.verify(undefined)).toBe(false)
    expect(store.verify("")).toBe(false)
  })

  test("issues distinct tokens", () => {
    const store = createSessionStore()
    expect(store.issue()).not.toBe(store.issue())
    expect(store.size()).toBe(2)
  })

  test("tracks issued tokens", () => {
    const store = createSessionStore()
    expect(store.size()).toBe(0)
    const token = store.issue()
    expect(store.size()).toBe(1)
    store.verify(token)
    expect(store.size()).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/session.test.ts` from `packages/mobile-gateway`
Expected: FAIL, cannot resolve `../src/session`.

- [ ] **Step 3: Implement `src/session.ts`**

```ts
export type SessionStore = {
  issue(): string
  verify(token: string | undefined): boolean
  size(): number
}

function defaultToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function createSessionStore(input?: { token?: () => string }): SessionStore {
  const tokens = new Set<string>()
  const makeToken = input?.token ?? defaultToken

  return {
    issue() {
      const token = makeToken()
      tokens.add(token)
      return token
    },
    verify(token) {
      if (!token) return false
      return tokens.has(token)
    },
    size() {
      return tokens.size
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/session.test.ts` from `packages/mobile-gateway`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/session.ts packages/mobile-gateway/test/session.test.ts
git commit -m "feat(mobile-gateway): add in-memory session token store"
```

---

### Task 3: Cookie parsing and serialization

**Files:**
- Create: `packages/mobile-gateway/src/cookies.ts`
- Test: `packages/mobile-gateway/test/cookies.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SESSION_COOKIE = "oc_mobile_session"`
  - `readCookie(header: string | null | undefined, name: string): string | undefined`
  - `sessionCookie(token: string): string` — a `Set-Cookie` value with `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=2592000`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/cookies.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { SESSION_COOKIE, readCookie, sessionCookie } from "../src/cookies"

describe("readCookie", () => {
  test("reads a cookie by name", () => {
    expect(readCookie("a=1; oc_mobile_session=abc; b=2", SESSION_COOKIE)).toBe("abc")
  })

  test("returns undefined when absent", () => {
    expect(readCookie("a=1", SESSION_COOKIE)).toBeUndefined()
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined()
    expect(readCookie("", SESSION_COOKIE)).toBeUndefined()
  })

  test("tolerates whitespace and empty segments", () => {
    expect(readCookie("  ;  oc_mobile_session = spaced ; ", SESSION_COOKIE)).toBe("spaced")
  })

  test("does not match a prefix of another cookie name", () => {
    expect(readCookie("oc_mobile_session_extra=nope", SESSION_COOKIE)).toBeUndefined()
  })
})

describe("sessionCookie", () => {
  test("sets the required attributes", () => {
    const value = sessionCookie("token123")
    expect(value).toBe("oc_mobile_session=token123; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/cookies.test.ts` from `packages/mobile-gateway`
Expected: FAIL, cannot resolve `../src/cookies`.

- [ ] **Step 3: Implement `src/cookies.ts`**

```ts
export const SESSION_COOKIE = "oc_mobile_session"

const MAX_AGE_SECONDS = 2592000

export function readCookie(header: string | null | undefined, name: string) {
  if (!header) return
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=")
    if (separator === -1) continue
    if (segment.slice(0, separator).trim() !== name) continue
    return segment.slice(separator + 1).trim()
  }
  return
}

export function sessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/cookies.test.ts` from `packages/mobile-gateway`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/cookies.ts packages/mobile-gateway/test/cookies.test.ts
git commit -m "feat(mobile-gateway): add cookie parsing and session cookie serialization"
```

---

### Task 4: Upstream resolution and credential probe

**Files:**
- Create: `packages/mobile-gateway/src/upstream.ts`
- Test: `packages/mobile-gateway/test/upstream.test.ts`

**Interfaces:**
- Consumes: `GatewayOptions`, `envAuthHeader` from `src/config.ts`.
- Produces:
  - `upstreamUrl(base: string, incomingUrl: string): URL`
  - `upstreamHeaders(input: { base: string; authorization: string; incoming?: Record<string, string> }): Record<string, string>`
  - `Upstream.probe(input: { base: string; authorization: string }): Promise<boolean>` — resolved iff a request to `${base}/api/session?limit=1` returns non-401

`upstreamUrl` must strip any inbound `auth_token` query parameter so it can never leak upstream.

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/upstream.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Upstream, upstreamHeaders, upstreamUrl } from "../src/upstream"

describe("upstreamUrl", () => {
  test("keeps path and query", () => {
    expect(upstreamUrl("http://127.0.0.1:4096", "http://gateway:4097/api/session?limit=1")).toBe(
      "http://127.0.0.1:4096/api/session?limit=1",
    )
  })

  test("preserves a base path prefix", () => {
    expect(upstreamUrl("http://127.0.0.1:4096/base", "http://gateway:4097/api/health")).toBe(
      "http://127.0.0.1:4096/base/api/health",
    )
  })

  test("strips auth_token from the query", () => {
    expect(upstreamUrl("http://127.0.0.1:4096", "http://gateway:4097/api/session?auth_token=abc&limit=1")).toBe(
      "http://127.0.0.1:4096/api/session?limit=1",
    )
  })
})

describe("upstreamHeaders", () => {
  test("replaces authorization and drops host and cookie", () => {
    const headers = upstreamHeaders({
      base: "http://127.0.0.1:4096",
      authorization: "Basic env",
      incoming: { host: "gateway:4097", cookie: "oc_mobile_session=x", accept: "application/json" },
    })
    expect(headers.authorization).toBe("Basic env")
    expect(headers.accept).toBe("application/json")
    expect(headers.host).toBeUndefined()
    expect(headers.cookie).toBeUndefined()
  })
})

describe("Upstream.probe", () => {
  test("returns false on 401", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 401 }),
    })
    const ok = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic wrong" })
    server.stop(true)
    expect(ok).toBe(false)
  })

  test("returns true on 200", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ data: [] }),
    })
    const ok = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic right" })
    server.stop(true)
    expect(ok).toBe(true)
  })

  test("returns false when upstream is unreachable", async () => {
    const ok = await Upstream.probe({ base: "http://127.0.0.1:1", authorization: "Basic right" })
    expect(ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/upstream.test.ts` from `packages/mobile-gateway`
Expected: FAIL, cannot resolve `../src/upstream`.

- [ ] **Step 3: Implement `src/upstream.ts`**

```ts
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
])

export function upstreamUrl(base: string, incomingUrl: string) {
  const incoming = new URL(incomingUrl)
  incoming.searchParams.delete("auth_token")
  const target = new URL(base)
  const prefix = target.pathname.replace(/\/+$/, "")
  target.pathname = `${prefix}${incoming.pathname}`
  target.search = incoming.search
  target.hash = ""
  return target
}

export function upstreamHeaders(input: {
  base: string
  authorization: string
  incoming?: Record<string, string>
}) {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.incoming ?? {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    headers[key] = value
  }
  headers.authorization = input.authorization
  return headers
}

async function probe(input: { base: string; authorization: string }) {
  const url = upstreamUrl(input.base, "http://gateway/api/session?limit=1")
  try {
    const response = await fetch(url, {
      headers: { authorization: input.authorization },
      signal: AbortSignal.timeout(5000),
    })
    return response.status !== 401
  } catch {
    return false
  }
}

export const Upstream = { probe }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/upstream.test.ts` from `packages/mobile-gateway`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/upstream.ts packages/mobile-gateway/test/upstream.test.ts
git commit -m "feat(mobile-gateway): add upstream resolution and credential probe"
```

---

### Task 5: Proxy response header transformation

**Files:**
- Create: `packages/mobile-gateway/src/proxy.ts`
- Test: `packages/mobile-gateway/test/proxy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `proxyResponseHeaders(headers: Headers): Headers`
  - `streamThrough(upstream: Response): Response` — returns a `Response` whose body is a live `ReadableStream` with upstream headers transformed, and a null body when upstream has none

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/proxy.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { proxyResponseHeaders, streamThrough } from "../src/proxy"

describe("proxyResponseHeaders", () => {
  test("strips transfer metadata but keeps content type", () => {
    const source = new Headers({
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": "123",
      "transfer-encoding": "chunked",
      "cache-control": "no-cache",
    })
    const result = proxyResponseHeaders(source)
    expect(result.get("content-type")).toBe("application/json")
    expect(result.get("cache-control")).toBe("no-cache")
    expect(result.get("content-encoding")).toBeNull()
    expect(result.get("content-length")).toBeNull()
    expect(result.get("transfer-encoding")).toBeNull()
  })
})

describe("streamThrough", () => {
  test("delivers chunks without buffering the whole body", async () => {
    const encoder = new TextEncoder()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first\n"))
      },
      async pull(controller) {
        await gate
        controller.enqueue(encoder.encode("second\n"))
        controller.close()
      },
    })
    const upstream = new Response(body, { headers: { "content-type": "text/event-stream" } })
    const result = streamThrough(upstream)

    const reader = result.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe("first\n")
    release()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe("second\n")
  })

  test("returns an empty body when upstream has none", () => {
    const upstream = new Response(null, { status: 204 })
    const result = streamThrough(upstream)
    expect(result.body).toBeNull()
    expect(result.status).toBe(204)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/proxy.test.ts` from `packages/mobile-gateway`
Expected: FAIL, cannot resolve `../src/proxy`.

- [ ] **Step 3: Implement `src/proxy.ts`**

```ts
const STRIPPED = ["content-encoding", "content-length", "transfer-encoding"]

export function proxyResponseHeaders(headers: Headers) {
  const result = new Headers(headers)
  for (const key of STRIPPED) result.delete(key)
  return result
}

export function streamThrough(upstream: Response) {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: proxyResponseHeaders(upstream.headers),
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/proxy.test.ts` from `packages/mobile-gateway`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/proxy.ts packages/mobile-gateway/test/proxy.test.ts
git commit -m "feat(mobile-gateway): add proxy response transformation"
```

---

### Task 6: Gateway request handling

**Files:**
- Create: `packages/mobile-gateway/src/gateway.ts`
- Test: `packages/mobile-gateway/test/gateway.test.ts`

**Interfaces:**
- Consumes: `GatewayOptions`, `envAuthHeader` (Task 1); `createSessionStore` (Task 2); `SESSION_COOKIE`, `readCookie`, `sessionCookie` (Task 3); `upstreamUrl`, `upstreamHeaders`, `Upstream.probe` (Task 4); `proxyResponseHeaders`, `streamThrough` (Task 5).
- Produces:
  - `type Gateway = { port: number; stop(): void }`
  - `startGateway(input: { options: GatewayOptions; port?: number }): Promise<Gateway>` — `port` overrides `options.port` for tests
  - `stopGateway(): void` — stops the singleton if running
  - `createGateway(input: { options: GatewayOptions }): (request: Request) => Promise<Response>` — exposed for direct testing; the public `startGateway` wraps it in `Bun.serve`

Auth decision, in order:
1. If the request carries a valid `SESSION_COOKIE`, proxy it.
2. If it carries `Authorization: Basic <base64(username:password)>` matching `options`, run `Upstream.probe`; on success issue a token, proxy the request upstream, and attach `Set-Cookie` to the proxied response. On failure return 401.
3. Otherwise return 401 with `WWW-Authenticate`.

The successful Basic request must still be proxied, not answered with a JSON body, because the browser sends its credentials on the page load itself. Returning a JSON stub there would show `{"status":"authorized"}` instead of the app.

Request bodies are buffered with `await request.arrayBuffer()` before forwarding. SSE streaming is response-side, so buffering small JSON prompt bodies does not affect stream behaviour.

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/gateway.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createGateway, startGateway, stopGateway } from "../src/gateway"
import { SESSION_COOKIE, sessionCookie } from "../src/cookies"
import type { GatewayOptions } from "../src/config"

const options: GatewayOptions = {
  host: "127.0.0.1",
  port: 0,
  upstream: "",
  username: "opencode",
  password: "secret",
}

const basic = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`

let upstream: ReturnType<typeof Bun.serve>
let upstreamRequests: string[] = []

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      upstreamRequests.push(`${request.method} ${url.pathname}${url.search}`)

      if (url.pathname === "/api/session") {
        if (request.headers.get("authorization") !== basic("opencode", "secret")) {
          return new Response("unauthorized", { status: 401 })
        }
        return Response.json({ data: [{ id: "ses_1" }] })
      }

      if (url.pathname === "/api/event") {
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("data: one\n\n"))
            controller.enqueue(encoder.encode("data: two\n\n"))
            controller.close()
          },
        })
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        })
      }

      return new Response("not found", { status: 404 })
    },
  })
  options.upstream = `http://127.0.0.1:${upstream.port}`
})

afterAll(() => {
  upstream.stop(true)
})

describe("createGateway", () => {
  const gateway = () => createGateway({ options })

  test("rejects a request with no credentials", async () => {
    const response = await gateway()(new Request("http://gateway/api/session"))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Basic")
  })

  test("rejects a wrong password without contacting the upstream", async () => {
    upstreamRequests = []
    const response = await gateway()(
      new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "wrong") } }),
    )
    expect(response.status).toBe(401)
    expect(upstreamRequests).toEqual([])
  })

  test("accepts a correct password, proxies the request, and issues a session cookie", async () => {
    upstreamRequests = []
    const response = await gateway()(
      new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "secret") } }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ id: "ses_1" }] })
    expect(upstreamRequests).toContain("GET /api/session")
    const cookie = response.headers.get("set-cookie")
    expect(cookie).toContain(`${SESSION_COOKIE}=`)
    expect(cookie).toContain("HttpOnly")
  })

  test("rejects a wrong cookie", async () => {
    upstreamRequests = []
    const response = await gateway()(
      new Request("http://gateway/api/session", { headers: { cookie: `${SESSION_COOKIE}=bogus` } }),
    )
    expect(response.status).toBe(401)
    expect(upstreamRequests).toEqual([])
  })

  test("proxies with a valid cookie and injects upstream credentials", async () => {
    const handle = gateway()
    const first = await handle(
      new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "secret") } }),
    )
    const cookie = first.headers.get("set-cookie")!.split(";")[0]
    upstreamRequests = []
    const response = await handle(new Request("http://gateway/api/session?limit=1", { headers: { cookie } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ id: "ses_1" }] })
    expect(upstreamRequests).toEqual(["GET /api/session?limit=1"])
  })

  test("streams SSE without buffering", async () => {
    const handle = gateway()
    const first = await handle(
      new Request("http://gateway/api/health", { headers: { authorization: basic("opencode", "secret") } }),
    )
    const cookie = first.headers.get("set-cookie")!.split(";")[0]
    const response = await handle(new Request("http://gateway/api/event", { headers: { cookie } }))
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n")
  })

  test("strips auth_token from the proxied query", async () => {
    const handle = gateway()
    const first = await handle(
      new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "secret") } }),
    )
    const cookie = first.headers.get("set-cookie")!.split(";")[0]
    upstreamRequests = []
    await handle(new Request("http://gateway/api/session?auth_token=leak&limit=1", { headers: { cookie } }))
    expect(upstreamRequests).toEqual(["GET /api/session?limit=1"])
  })
})

describe("startGateway", () => {
  test("binds an ephemeral port and stops cleanly", async () => {
    const running = await startGateway({ options, port: 0 })
    expect(running.port).toBeGreaterThan(0)
    const response = await fetch(`http://127.0.0.1:${running.port}/api/session`)
    expect(response.status).toBe(401)
    stopGateway()
    await expect(fetch(`http://127.0.0.1:${running.port}/api/session`)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/gateway.test.ts` from `packages/mobile-gateway`
Expected: FAIL, cannot resolve `../src/gateway`.

- [ ] **Step 3: Implement `src/gateway.ts`**

```ts
import { SESSION_COOKIE, readCookie, sessionCookie } from "./cookies"
import { envAuthHeader, type GatewayOptions } from "./config"
import { streamThrough } from "./proxy"
import { createSessionStore } from "./session"
import { Upstream, upstreamHeaders, upstreamUrl } from "./upstream"

const UNAUTHORIZED = 'Basic realm="opencode-mobile"'

export type Gateway = {
  port: number
  stop(): void
}

let running: { server: ReturnType<typeof Bun.serve>; refs: number; stop: () => void } | undefined

function unauthorized() {
  return new Response("Authentication required", { status: 401, headers: { "www-authenticate": UNAUTHORIZED } })
}

function decodeBasic(header: string | null) {
  if (!header) return
  const match = /^Basic\s+(.+)$/i.exec(header)
  if (!match) return
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8")
    const separator = decoded.indexOf(":")
    if (separator === -1) return
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
  } catch {
    return
  }
}

export function createGateway(input: { options: GatewayOptions }) {
  const options = input.options
  const authorization = envAuthHeader(options)
  const sessions = createSessionStore()

  function matchesEnv(credentials: { username: string; password: string }) {
    return credentials.username === options.username && credentials.password === options.password
  }

  return async function handle(request: Request): Promise<Response> {
    const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE)
    const cookieValid = token !== undefined && sessions.verify(token)

    let issued: string | undefined
    if (!cookieValid) {
      const credentials = decodeBasic(request.headers.get("authorization"))
      if (!credentials) return unauthorized()
      if (!matchesEnv(credentials)) return unauthorized()
      if (!(await Upstream.probe({ base: options.upstream, authorization }))) return unauthorized()
      issued = sessions.issue()
    }

    const target = upstreamUrl(options.upstream, request.url)
    const headers = upstreamHeaders({
      base: options.upstream,
      authorization,
      incoming: Object.fromEntries(request.headers.entries()),
    })
    const method = request.method
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer()

    let upstream: Response
    try {
      upstream = await fetch(target, { method, headers, body })
    } catch {
      return new Response("Upstream unavailable", { status: 502 })
    }

    const response = streamThrough(upstream)
    if (issued !== undefined) response.headers.set("set-cookie", sessionCookie(issued))
    return response
  }
}

export async function startGateway(input: { options: GatewayOptions; port?: number }): Promise<Gateway> {
  if (running) {
    running.refs += 1
    return { port: running.server.port ?? 0, stop: release }
  }
  const handle = createGateway({ options: input.options })
  const server = Bun.serve({
    hostname: input.options.host,
    port: input.port ?? input.options.port,
    fetch: handle,
  })
  running = {
    server,
    refs: 1,
    stop: () => {
      server.stop(true)
      running = undefined
    },
  }
  return { port: server.port ?? 0, stop: release }
}

// The plugin hook is created once per opened directory, so the gateway is
// reference-counted. The last disposer closes the listener.
function release() {
  if (!running) return
  running.refs -= 1
  if (running.refs > 0) return
  running.stop()
}

export function stopGateway() {
  running?.stop()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/gateway.test.ts` from `packages/mobile-gateway`
Expected: PASS, 8 tests. If the `startGateway` test's second `fetch` does not reject (Bun may keep the socket warm), replace that assertion with a `stopGateway()` idempotency check instead of weakening it to a no-op.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test` and `bun typecheck` from `packages/mobile-gateway`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile-gateway/src/gateway.ts packages/mobile-gateway/test/gateway.test.ts
git commit -m "feat(mobile-gateway): add authenticated reverse proxy gateway"
```

---

### Task 7: Plugin entry

**Files:**
- Create: `packages/mobile-gateway/src/index.ts`
- Test: `packages/mobile-gateway/test/plugin.test.ts`

**Interfaces:**
- Consumes: `resolveOptions` (Task 1); `startGateway`, `stopGateway` (Task 6).
- Produces: the default export `{ id: "@flynncode/mobile-gateway", server: Plugin }` where `Plugin` is `(input: PluginInput, options?: PluginOptions) => Promise<Hooks>`.

The plugin must never throw during load: a missing password or a busy port logs a message and returns empty hooks, because a throwing plugin is logged as a failure and skipped by the loader (`packages/opencode/src/plugin/index.ts:226-243`).

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/plugin.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import mobileGateway from "../src/index"
import { stopGateway } from "../src/gateway"

const input = {
  client: {} as never,
  project: {} as never,
  directory: "/tmp",
  worktree: "/tmp",
  serverUrl: new URL("http://127.0.0.1:4096"),
  $: undefined as never,
  experimental_workspace: { register() {} },
}

describe("plugin entry", () => {
  test("exposes an id and a server function", () => {
    expect(mobileGateway.id).toBe("@flynncode/mobile-gateway")
    expect(typeof mobileGateway.server).toBe("function")
  })

  test("returns hooks without throwing when the password is unset", async () => {
    const previous = process.env.OPENCODE_SERVER_PASSWORD
    delete process.env.OPENCODE_SERVER_PASSWORD
    const hooks = await mobileGateway.server(input)
    expect(typeof hooks).toBe("object")
    await hooks.dispose?.()
    if (previous !== undefined) process.env.OPENCODE_SERVER_PASSWORD = previous
  })

  test("starts a gateway when the password is set and closes it on dispose", async () => {
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousPort = process.env.OPENCODE_MOBILE_PORT
    const previousUpstream = process.env.OPENCODE_MOBILE_UPSTREAM
    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    process.env.OPENCODE_MOBILE_PORT = "0"
    process.env.OPENCODE_MOBILE_UPSTREAM = "http://127.0.0.1:4096"

    const hooks = await mobileGateway.server(input)

    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
    if (previousPort === undefined) delete process.env.OPENCODE_MOBILE_PORT
    else process.env.OPENCODE_MOBILE_PORT = previousPort
    if (previousUpstream === undefined) delete process.env.OPENCODE_MOBILE_UPSTREAM
    else process.env.OPENCODE_MOBILE_UPSTREAM = previousUpstream

    expect(hooks).toBeDefined()
    expect(hooks.dispose).toBeInstanceOf(Function)
    await hooks.dispose?.()
    stopGateway()
  })

  test("still returns hooks when the port is already taken", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") })
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousPort = process.env.OPENCODE_MOBILE_PORT
    const previousHost = process.env.OPENCODE_MOBILE_HOST
    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    process.env.OPENCODE_MOBILE_HOST = "127.0.0.1"
    process.env.OPENCODE_MOBILE_PORT = String(blocker.port)

    const hooks = await mobileGateway.server(input)

    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
    if (previousPort === undefined) delete process.env.OPENCODE_MOBILE_PORT
    else process.env.OPENCODE_MOBILE_PORT = previousPort
    if (previousHost === undefined) delete process.env.OPENCODE_MOBILE_HOST
    else process.env.OPENCODE_MOBILE_HOST = previousHost

    expect(hooks).toEqual({})
    blocker.stop(true)
  })
})
```

The gateway binds `process.env.OPENCODE_MOBILE_HOST`/`PORT` directly, so env vars are restored before any assertions run to avoid leaking state into other tests. The two tests cover the success path and the "never throw" contract.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/plugin.test.ts` from `packages/mobile-gateway`
Expected: FAIL, cannot resolve `../src/index`.

- [ ] **Step 3: Implement `src/index.ts`**

```ts
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { resolveOptions } from "./config"
import { startGateway, stopGateway } from "./gateway"

const id = "@flynncode/mobile-gateway"

async function server(_input: PluginInput, _options?: PluginOptions): Promise<Hooks> {
  const resolved = resolveOptions(process.env)
  if (!resolved.ok) {
    console.log(`[mobile-gateway] disabled: ${resolved.reason}`)
    return {}
  }

  try {
    const gateway = await startGateway({ options: resolved.value })
    console.log(`[mobile-gateway] listening on http://${resolved.value.host}:${gateway.port}`)
    return {
      async dispose() {
        gateway.stop()
      },
    }
  } catch (error) {
    console.log(`[mobile-gateway] failed to start: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

export default { id, server }
export { id }
```

`@opencode-ai/plugin` is a type-only import here, so add it as a dev dependency in `package.json`:

```json
"devDependencies": {
  "@opencode-ai/plugin": "workspace:*",
  ...existing entries
}
```

Then run `bun install` again.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/plugin.test.ts` from `packages/mobile-gateway`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test` and `bun typecheck` from `packages/mobile-gateway`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile-gateway/src/index.ts packages/mobile-gateway/test/plugin.test.ts packages/mobile-gateway/package.json bun.lock
git commit -m "feat(mobile-gateway): add plugin entry"
```

---

### Task 8: Standalone bin

**Files:**
- Create: `packages/mobile-gateway/src/bin.ts`
- Modify: `packages/mobile-gateway/package.json` (files list already includes `src`)
- Test: manual, plus reuse of `startGateway` coverage

**Interfaces:**
- Consumes: `resolveOptions` (Task 1); `startGateway` (Task 6).
- Produces: a CLI that exits `1` with a message on invalid config, otherwise prints the listen URL and waits.

- [ ] **Step 1: Implement `src/bin.ts`**

```ts
#!/usr/bin/env bun
import { resolveOptions } from "./config"
import { startGateway } from "./gateway"

const resolved = resolveOptions(process.env)
if (!resolved.ok) {
  console.error(`[mobile-gateway] ${resolved.reason}`)
  process.exit(1)
}

const gateway = await startGateway({ options: resolved.value })
console.log(`[mobile-gateway] listening on http://${resolved.value.host}:${gateway.port}`)
console.log(`[mobile-gateway] upstream ${resolved.value.upstream}`)

const shutdown = () => {
  gateway.stop()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

await new Promise(() => {})
```

- [ ] **Step 2: Verify it fails fast on missing config**

Run: `env -u OPENCODE_SERVER_PASSWORD bun run src/bin.ts`
Expected: exits `1`, prints the missing-password reason.

- [ ] **Step 3: Verify it binds and authenticates end to end**

Run: `OPENCODE_SERVER_PASSWORD=secret OPENCODE_MOBILE_PORT=0 bun run src/bin.ts` in one terminal, then in another:

```bash
curl -i http://127.0.0.1:<port>/api/health
```

Expected: `401` with `www-authenticate: Basic realm="opencode-mobile"`.

Then:

```bash
curl -i -u opencode:secret http://127.0.0.1:<port>/api/health
```

Expected: `200` with a `set-cookie` header containing `oc_mobile_session`. Stop the bin with Ctrl-C.

- [ ] **Step 4: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/bin.ts
git commit -m "feat(mobile-gateway): add standalone bin"
```

---

### Task 9: Wire into the repo and document setup

**Files:**
- Modify: none in `packages/opencode` (no code change needed)
- Create: `packages/mobile-gateway/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: install instructions and the manual phone checklist.

- [ ] **Step 1: Confirm the plugin loads through the real loader**

From `packages/opencode`, run the loader against the package directory to confirm entrypoint resolution, using an inline script:

```bash
bun -e 'import { createPluginEntry } from "./src/plugin/shared"; const entry = await createPluginEntry("../../packages/mobile-gateway", "../../packages/mobile-gateway", "server"); console.log(JSON.stringify(entry, null, 2))'
```

Expected: `entry.entry` is a `file://` URL ending in `src/index.ts`, and `source` is `file`.

If it fails with "missing package.json or index file", the `exports["./server"]` key is wrong; fix `package.json` rather than the loader.

- [ ] **Step 2: Write `README.md`**

````markdown
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
````

- [ ] **Step 3: Run the full package suite, typecheck, and lint**

```bash
cd packages/mobile-gateway && bun test && bun typecheck
cd ../.. && bun run lint
```

Expected: tests PASS, typecheck clean, lint reports no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/mobile-gateway/README.md
git commit -m "docs(mobile-gateway): add setup and phone instructions"
```

---

## Manual Checklist

After all tasks, verify on a real phone:

- [ ] `OPENCODE_SERVER_PASSWORD` unset → plugin logs `disabled` and opencode starts normally.
- [ ] Password set, opencode started, plugin loaded → log shows the listen URL.
- [ ] Browsing to the gateway URL from a desktop browser prompts for credentials.
- [ ] Wrong password → 401 every time, no cookie issued.
- [ ] Correct password → app loads and the session list appears.
- [ ] Opening a session shows its messages.
- [ ] A prompt sent from the phone appears in the desktop session.
- [ ] Streaming output updates live on the phone without a refresh.
- [ ] Aborting from the phone stops the run.
- [ ] A permission prompt raised on the desktop appears on the phone and can be answered.
- [ ] A question prompt can be answered from the phone.
- [ ] Add to Home Screen launches standalone without browser chrome.
- [ ] Restarting the gateway invalidates old cookies (phone prompts again).
