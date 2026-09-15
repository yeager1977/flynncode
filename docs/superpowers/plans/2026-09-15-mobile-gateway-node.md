# Mobile Gateway Node Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@flynncode/mobile-gateway` work inside the Flynncode desktop app, where the server runs in an Electron Node utility process with no `Bun` global, and give the phone a stable gateway password.

**Architecture:** Replace the `Bun.serve` listener in `src/gateway.ts` with a `node:http` `createServer` plus explicit `Request`/`Response` bridging, which runs identically under Bun and Node. Add `.ts` file extensions to all relative imports so Node's native TypeScript loader can resolve them. Introduce `OPENCODE_MOBILE_PASSWORD` (falling back to `OPENCODE_SERVER_PASSWORD`) so the phone's credential is stable while the upstream hop keeps using the desktop's rotating password. Default the upstream to `PluginInput.serverUrl` so the desktop's random port is followed automatically.

**Tech Stack:** TypeScript, `node:http`/`node:stream`, `bun:test`, Electron 42 (Node 24.15).

## Global Constraints

- Package path: `packages/mobile-gateway`. No new runtime dependencies.
- Relative imports inside `packages/mobile-gateway/src` must carry an explicit `.ts` extension. Node's native TS loader (`ERR_MODULE_NOT_FOUND` on extensionless specifiers) does not do extension resolution; Bun accepts explicit extensions.
- `node:http` `createServer` replaces `Bun.serve` in `src/gateway.ts`. No `Bun.*` references may remain in `src/`.
- `startGateway` must remain usable from both Bun and Node. `Gateway` keeps the shape `{ port: number; stop(): void }`.
- Reference counting, per-handle release guards, and stale-handle protection must be preserved exactly as currently reviewed. Do not weaken them.
- Gateway credential resolution order: `options.password` from plugin options (if provided) → `env.OPENCODE_MOBILE_PASSWORD` → `env.OPENCODE_SERVER_PASSWORD`. Upstream credentials always come from `env.OPENCODE_SERVER_USERNAME` (default `opencode`) and `env.OPENCODE_SERVER_PASSWORD`.
- New env var `OPENCODE_MOBILE_PASSWORD`: when set, the phone authenticates with this value. When unset, the gateway falls back to `OPENCODE_SERVER_PASSWORD` (existing behavior, preserves the bin path and the shipped spec).
- Upstream URL resolution order: explicit `OPENCODE_MOBILE_UPSTREAM` → the plugin's `input.serverUrl` → `http://127.0.0.1:4096`.
- `node:http`, `node:stream`, and `node:stream/promises` are Node builtins available in both Bun and Node; they must not be replaced with `Bun.*` equivalents.
- `set-cookie` must be forwarded via `Headers.getSetCookie()`; the rest of the headers via `headers.entries()`. Node's `writeHead` accepts an array for `set-cookie`.
- SSE responses must stream incrementally under Node, never buffered.
- Tests use `bun test` from `packages/mobile-gateway`. Never run tests from the repo root.
- Typecheck with `bun typecheck` (`tsgo --noEmit`) from the package directory. Never invoke `tsc` directly.
- No `export namespace`. No import aliases. No star imports. No `any` in exported signatures. No comments unless a constraint is non-obvious.
- `@types/node` must be added as a dev dependency (from the catalog) so `node:http` types resolve; `@types/bun` alone is insufficient for the Node bridge.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/mobile-gateway/src/gateway.ts` | Rewritten listener: `node:http` server, Request/Response bridge, ref-counted lifecycle |
| `packages/mobile-gateway/src/config.ts` | Credential resolution (`OPENCODE_MOBILE_PASSWORD` fallback chain), upstream default |
| `packages/mobile-gateway/src/index.ts` | Plugin entry: reads options, uses `input.serverUrl` as upstream fallback |
| `packages/mobile-gateway/src/{cookies,session,upstream,proxy,bin}.ts` | Relative imports gain `.ts` extensions |
| `packages/mobile-gateway/package.json` | `@types/node` dev dependency |
| `packages/mobile-gateway/test/gateway.test.ts` | Node-bridge behaviors, ref-count lifecycle unchanged |
| `packages/mobile-gateway/test/config.test.ts` | Credential fallback chain |
| `packages/mobile-gateway/test/node-runtime.test.ts` | Spawns Electron's Node to prove the package loads and serves without `Bun` |

---

### Task 1: Node-compatible listener

**Files:**
- Modify: `packages/mobile-gateway/src/gateway.ts` (full rewrite of the listener and lifecycle)
- Modify: `packages/mobile-gateway/package.json` (add `@types/node`)
- Test: `packages/mobile-gateway/test/gateway.test.ts`

**Interfaces:**
- Consumes: `createGateway` (unchanged shape), `release` semantics from the existing reviewed implementation.
- Produces: `startGateway(input: { options: GatewayOptions; port?: number }): Promise<Gateway>` and `stopGateway(): void`, both now backed by `node:http`. `Gateway = { port: number; stop(): void }` unchanged.

The existing test file already covers auth, proxying, SSE, `auth_token` stripping, and the full ref-count lifecycle. Those tests must keep passing against the new listener; the bridge adds Node-specific coverage.

- [ ] **Step 1: Add `@types/node`**

In `packages/mobile-gateway/package.json`, add to `devDependencies`:

```json
"@types/node": "catalog:"
```

Run: `bun install` from the repo root.

- [ ] **Step 2: Write the new bridge tests first**

Append to `packages/mobile-gateway/test/gateway.test.ts` inside the existing `describe("startGateway", ...)` block:

```ts
  test("forwards a POST body through the node bridge", async () => {
    const seen: string[] = []
    const echo = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        seen.push(await request.text())
        return new Response("echoed", { headers: { "content-type": "text/plain" } })
      },
    })
    const handle = startGateway({
      options: { host: "127.0.0.1", port: 0, upstream: `http://127.0.0.1:${echo.port}`, username: "opencode", password: "secret" },
    })
    const running = await handle
    const auth = basic("opencode", "secret")
    const response = await fetch(`http://127.0.0.1:${running.port}/api/session`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("echoed")
    // The upstream probe is a GET with an empty body, so filter it out; the
    // proxied POST is the only non-empty body the upstream sees.
    expect(seen.filter((body) => body !== "")).toEqual(['{"prompt":"hello"}'])
    stopGateway()
    echo.stop(true)
  })

  test("forwards multiple set-cookie headers", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        const headers = new Headers({ "content-type": "text/plain" })
        headers.append("set-cookie", "a=1; Path=/")
        headers.append("set-cookie", "b=2; Path=/")
        return new Response("ok", { headers })
      },
    })
    const running = await startGateway({
      options: { host: "127.0.0.1", port: 0, upstream: `http://127.0.0.1:${upstream.port}`, username: "opencode", password: "secret" },
    })
    // The Basic handshake replaces set-cookie with the gateway session cookie,
    // so bootstrap a session first and exercise the cookie path, which passes
    // upstream cookies through untransformed.
    const first = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    const response = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { cookie },
    })
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"])
    stopGateway()
    upstream.stop(true)
  })

  test("streams SSE incrementally through the node bridge", async () => {
    const encoder = new TextEncoder()
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode("data: one\n\n"))
              await Bun.sleep(200)
              controller.enqueue(encoder.encode("data: two\n\n"))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } },
        ),
    })
    const running = await startGateway({
      options: { host: "127.0.0.1", port: 0, upstream: `http://127.0.0.1:${upstream.port}`, username: "opencode", password: "secret" },
    })
    const first = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    const started = Date.now()
    const response = await fetch(`http://127.0.0.1:${running.port}/api/event`, { headers: { cookie } })
    expect(response.headers.get("content-type")).toBe("text/event-stream")

    const reader = response.body!.getReader()
    const firstChunkAt = Date.now()
    const chunk = await reader.read()
    expect(new TextDecoder().decode(chunk.value)).toBe("data: one\n\n")
    expect(firstChunkAt - started).toBeLessThan(150)
    while (!(await reader.read()).done) {}
    stopGateway()
    upstream.stop(true)
  })

  test("returns 500 rather than crashing when the handler throws", async () => {
    const running = await startGateway({
      options: { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1:1", username: "opencode", password: "secret" },
    })
    const response = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect([500, 503]).toContain(response.status)
    stopGateway()
  })
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `bun test test/gateway.test.ts` from `packages/mobile-gateway`
Expected: FAIL. The bridge tests may fail on `getSetCookie` equality or the SSE timing assertion against the `Bun.serve` implementation, and the POST-body test should expose any bridging difference.

- [ ] **Step 4: Rewrite `src/gateway.ts`**

Replace the listener and lifecycle portion. Imports become:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { SESSION_COOKIE, readCookie, sessionCookie } from "./cookies.ts"
import { envAuthHeader, type GatewayOptions } from "./config.ts"
import { streamThrough } from "./proxy.ts"
import { createSessionStore } from "./session.ts"
import { Upstream, upstreamHeaders, upstreamUrl } from "./upstream.ts"
```

Lifecycle types and state:

```ts
type RunningState = { server: Server; port: number; refs: number; stop: () => void }

let running: RunningState | undefined
```

Then `createGateway` stays exactly as-is, and the lifecycle becomes:

```ts
export async function startGateway(input: { options: GatewayOptions; port?: number }): Promise<Gateway> {
  if (running) {
    running.refs += 1
    const state = running
    const released = { value: false }
    return { port: state.port, stop: () => release(state, released) }
  }
  const handle = createGateway({ options: input.options })
  const server = createServer((request, response) => {
    Promise.resolve(requestFromNode(request))
      .then(handle)
      .then((result) => writeToNode(response, result))
      .catch(() => {
        response.writeHead(500)
        response.end("Internal error")
      })
  })
  const port = await listen(server, input.options.host, input.port ?? input.options.port)
  running = {
    server,
    port,
    refs: 1,
    stop: () => {
      server.closeAllConnections()
      server.close()
      if (running?.server === server) running = undefined
    },
  }
  const state = running
  const released = { value: false }
  return { port, stop: () => release(state, released) }
}

function listen(server: Server, host: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.removeListener("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve gateway port"))
        return
      }
      resolve(address.port)
    })
  })
}

function requestFromNode(request: IncomingMessage) {
  const method = request.method ?? "GET"
  const url = `http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`
  const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(request)
  return new Request(url, {
    method,
    headers: request.headers as Record<string, string>,
    body,
    duplex: "half",
  }) as Request
}

async function writeToNode(response: ServerResponse, result: Response) {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of result.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue
    headers[key] = value
  }
  const cookies = result.headers.getSetCookie()
  if (cookies.length) headers["set-cookie"] = cookies
  response.writeHead(result.status, headers)
  if (!result.body) {
    response.end()
    return
  }
  await pipeline(Readable.fromWeb(result.body as never), response).catch(() => response.end())
}

// The plugin hook is created once per opened directory, so the gateway is
// reference-counted. The last disposer closes the listener.
function release(state: RunningState, released: { value: boolean }) {
  if (released.value) return
  released.value = true
  if (state.refs <= 0) return
  state.refs -= 1
  if (state.refs > 0) return
  state.stop()
}

export function stopGateway() {
  running?.stop()
}
```

Two constraints this code depends on, both verified by prototype under Electron's Node:

- `Readable.toWeb(request)` yields a live body, so the credential path's `await request.arrayBuffer()` in `createGateway` streams the request correctly.
- If `createGateway` returns a 401 without consuming the body, Node answers and the socket is discarded; a subsequent request on a fresh connection is unaffected.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/gateway.test.ts` from `packages/mobile-gateway`
Expected: PASS, all previously passing tests plus the four new bridge tests.

- [ ] **Step 6: Confirm no `Bun` references remain in `src/`**

Run: `grep -rn "Bun\." packages/mobile-gateway/src/`
Expected: no output.

- [ ] **Step 7: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/gateway.ts packages/mobile-gateway/test/gateway.test.ts packages/mobile-gateway/package.json bun.lock
git commit -m "fix(mobile-gateway): use node:http listener so the gateway runs in the desktop app"
```

---

### Task 2: `.ts` import extensions for Node's loader

**Files:**
- Modify: `packages/mobile-gateway/src/cookies.ts` (no import changes), `session.ts` (none), `proxy.ts` (none), `upstream.ts` (none), `config.ts` (none) — these have no relative imports
- Modify: `packages/mobile-gateway/src/bin.ts`, `packages/mobile-gateway/src/index.ts`, `packages/mobile-gateway/src/gateway.ts`
- Test: `packages/mobile-gateway/test/node-runtime.test.ts` (new)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: a package whose `src/*.ts` entrypoints load under Node's native TypeScript loader, proved by an automated test that spawns Electron in `ELECTRON_RUN_AS_NODE` mode.

Bun resolves extensionless relative specifiers; Node does not. Explicit `.ts` resolves in both, so one source tree serves both runtimes.

- [ ] **Step 1: Add the extensions**

Add `.ts` to every relative import in `src/`. The three affected files:

```ts
// packages/mobile-gateway/src/bin.ts
import { resolveOptions } from "./config.ts"
import { startGateway } from "./gateway.ts"

// packages/mobile-gateway/src/index.ts
import { resolveOptions } from "./config.ts"
import { startGateway } from "./gateway.ts"

// packages/mobile-gateway/src/gateway.ts — already done in Task 1
```

Confirm with: `grep -rn 'from "\./' packages/mobile-gateway/src/` — every line must end in `.ts"`.

- [ ] **Step 2: Write the runtime test**

Create `packages/mobile-gateway/test/node-runtime.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

const packageDir = join(import.meta.dir, "..")
const repoRoot = join(packageDir, "..", "..")
const electron = join(repoRoot, "packages", "desktop", "node_modules", "electron", "dist", "electron")

const harness = (dir: string) => join(dir, "test", "fixtures", "node-runtime-harness.mjs")

describe("node runtime", () => {
  test("the package loads and serves under Electron's Node without Bun", async () => {
    const electronPath = electron
    if (!existsSync(electronPath)) {
      console.log("skipping: electron binary not installed")
      return
    }
    const script = harness(packageDir)
    const result = await Bun.$`${electronPath} ${script}`.env({
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      OPENCODE_SERVER_PASSWORD: "secret",
      OPENCODE_MOBILE_PASSWORD: "phone-secret",
    }).quiet().nothrow()
    const output = result.stdout.toString() + result.stderr.toString()
    expect(output).toContain("NODE_RUNTIME_OK")
  }, 60000)
})
```

Create `packages/mobile-gateway/test/fixtures/node-runtime-harness.mjs`:

```js
import { createServer } from "node:http"
import { startGateway } from "../../src/gateway.ts"

const upstream = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" })
  response.end("upstream-ok")
})
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
const upstreamPort = upstream.address().port

const gateway = await startGateway({
  options: {
    host: "127.0.0.1",
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    username: "opencode",
    password: "secret",
  },
})

const unauthorized = await fetch(`http://127.0.0.1:${gateway.port}/api/health`)
const authorized = await fetch(`http://127.0.0.1:${gateway.port}/api/health`, {
  headers: { authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}` },
})
const body = await authorized.text()
const cookie = authorized.headers.getSetCookie()[0] ?? ""

gateway.stop()
upstream.close()

if (unauthorized.status !== 401) throw new Error(`expected 401, got ${unauthorized.status}`)
if (authorized.status !== 200) throw new Error(`expected 200, got ${authorized.status}`)
if (body !== "upstream-ok") throw new Error(`unexpected body: ${body}`)
if (!cookie.includes("oc_mobile_session=")) throw new Error("missing session cookie")
console.log("NODE_RUNTIME_OK")
```

- [ ] **Step 3: Run the runtime test to verify it fails without the extensions**

Temporarily remove `.ts` from one import in `src/index.ts` and run:
`bun test test/node-runtime.test.ts` from `packages/mobile-gateway`
Expected: FAIL — the harness reports a module-resolution error, proving the test exercises the real loader.

- [ ] **Step 4: Restore the extension and run to verify it passes**

Run: `bun test test/node-runtime.test.ts` from `packages/mobile-gateway`
Expected: PASS. The Electron subprocess prints `NODE_RUNTIME_OK`.

If the electron binary is absent in a given environment the test logs a skip rather than failing; note that in the report.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test` and `bun typecheck` from `packages/mobile-gateway`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile-gateway/src packages/mobile-gateway/test
git commit -m "fix(mobile-gateway): add .ts import extensions for Node's native loader"
```

---

### Task 3: Stable gateway password

**Files:**
- Modify: `packages/mobile-gateway/src/config.ts`
- Modify: `packages/mobile-gateway/src/index.ts`
- Test: `packages/mobile-gateway/test/config.test.ts`

**Interfaces:**
- Consumes: `GatewayOptions`, `resolveOptions`, `envAuthHeader` from `src/config.ts`.
- Produces:
  - `GatewayOptions` gains `upstreamPassword: string` — the credential used for the upstream hop, always `OPENCODE_SERVER_PASSWORD`.
  - `envAuthHeader` continues to derive the **upstream** header from `username` + `upstreamPassword`.
  - The gateway's own credential remains `options.password`, now sourced from `OPENCODE_MOBILE_PASSWORD` when present.
  - `resolveOptions(env, fallbackUpstream?)` gains an optional second parameter.

The desktop rotates `OPENCODE_SERVER_PASSWORD` every launch, so it cannot be the phone's credential. The phone gets `OPENCODE_MOBILE_PASSWORD`; the desktop's rotating value is used only for the loopback hop.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mobile-gateway/test/config.test.ts`:

```ts
describe("gateway credential resolution", () => {
  test("prefers OPENCODE_MOBILE_PASSWORD for the phone", () => {
    const result = resolveOptions({ OPENCODE_SERVER_PASSWORD: "upstream", OPENCODE_MOBILE_PASSWORD: "phone" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.password).toBe("phone")
    expect(result.value.upstreamPassword).toBe("upstream")
  })

  test("falls back to the server password when the mobile password is unset", () => {
    const result = resolveOptions({ OPENCODE_SERVER_PASSWORD: "only" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.password).toBe("only")
    expect(result.value.upstreamPassword).toBe("only")
  })

  test("treats an empty mobile password as unset", () => {
    const result = resolveOptions({ OPENCODE_SERVER_PASSWORD: "upstream", OPENCODE_MOBILE_PASSWORD: "" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.password).toBe("upstream")
  })

  test("still requires the upstream server password", () => {
    expect(resolveOptions({ OPENCODE_MOBILE_PASSWORD: "phone" }).ok).toBe(false)
  })

  test("uses the fallback upstream when no override is set", () => {
    const result = resolveOptions({ OPENCODE_SERVER_PASSWORD: "s" }, "http://127.0.0.1:33475")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.upstream).toBe("http://127.0.0.1:33475")
  })

  test("prefers the explicit upstream override over the fallback", () => {
    const result = resolveOptions(
      { OPENCODE_SERVER_PASSWORD: "s", OPENCODE_MOBILE_UPSTREAM: "http://127.0.0.1:5000" },
      "http://127.0.0.1:33475",
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.upstream).toBe("http://127.0.0.1:5000")
  })
})

describe("envAuthHeader", () => {
  test("derives the upstream header from the upstream password", () => {
    const header = envAuthHeader({
      host: "0.0.0.0",
      port: 4097,
      upstream: "http://127.0.0.1:4096",
      username: "opencode",
      password: "phone",
      upstreamPassword: "upstream",
    })
    expect(header).toBe(`Basic ${Buffer.from("opencode:upstream").toString("base64")}`)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/config.test.ts` from `packages/mobile-gateway`
Expected: FAIL — `upstreamPassword` is undefined and the fallback parameter does not exist.

- [ ] **Step 3: Implement the resolution**

In `src/config.ts`, extend the type and resolution:

```ts
export type GatewayOptions = {
  host: string
  port: number
  upstream: string
  username: string
  password: string
  upstreamPassword: string
}
```

In `resolveOptions`, add the optional second parameter `fallbackUpstream?: string` and change the credential block:

```ts
export function resolveOptions(
  env: Record<string, string | undefined>,
  fallbackUpstream?: string,
): ResolveResult {
  const upstreamPassword = env.OPENCODE_SERVER_PASSWORD ?? ""
  if (!upstreamPassword) {
    return { ok: false, reason: "OPENCODE_SERVER_PASSWORD must be set and non-empty to start the mobile gateway" }
  }
  const mobilePassword = env.OPENCODE_MOBILE_PASSWORD ?? ""

  const port = readPort(env.OPENCODE_MOBILE_PORT)
  if (port === "invalid") return { ok: false, reason: `OPENCODE_MOBILE_PORT is not a valid port` }

  const upstream = normalizeUpstream(env.OPENCODE_MOBILE_UPSTREAM ?? fallbackUpstream ?? DEFAULT_UPSTREAM)
  if (!upstream) return { ok: false, reason: "OPENCODE_MOBILE_UPSTREAM is not a valid http(s) URL" }

  return {
    ok: true,
    value: {
      host: env.OPENCODE_MOBILE_HOST ?? DEFAULT_HOST,
      port: port ?? DEFAULT_PORT,
      upstream,
      username: env.OPENCODE_SERVER_USERNAME ?? DEFAULT_USERNAME,
      password: mobilePassword || upstreamPassword,
      upstreamPassword,
    },
  }
}
```

Update `envAuthHeader` to use the upstream credential:

```ts
export function envAuthHeader(options: GatewayOptions): string {
  return `Basic ${Buffer.from(`${options.username}:${options.upstreamPassword}`).toString("base64")}`
}
```

`normalizeUpstream` must keep rejecting non-http(s) schemes and stripping trailing slashes; it already throws internally on a malformed value and returns `undefined`, which the caller turns into the `reason` above.

- [ ] **Step 4: Update existing tests for the new field**

Every existing `GatewayOptions` literal in `test/config.test.ts`, `test/gateway.test.ts`, and `test/upstream.test.ts` needs `upstreamPassword`. Where a test's options previously set `password: "secret"`, add `upstreamPassword: "secret"` so behavior is unchanged. Where `test/gateway.test.ts` asserts the upstream receives `basic("opencode", "secret")`, it continues to pass because the upstream credential is unchanged.

- [ ] **Step 5: Run the full suite**

Run: `bun test` from `packages/mobile-gateway`
Expected: all tests PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
cd packages/mobile-gateway && bun typecheck
git add packages/mobile-gateway/src/config.ts packages/mobile-gateway/test
git commit -m "feat(mobile-gateway): add stable gateway password separate from the upstream credential"
```

Note: the spec's "reuse the server password" behavior is preserved exactly when `OPENCODE_MOBILE_PASSWORD` is unset, so the bin path and the originally shipped design are unchanged.

---

### Task 4: Plugin entry uses the live server URL

**Files:**
- Modify: `packages/mobile-gateway/src/index.ts`
- Test: `packages/mobile-gateway/test/plugin.test.ts`

**Interfaces:**
- Consumes: `resolveOptions(env, fallbackUpstream?)` from Task 3, `startGateway` from Task 1.
- Produces: the plugin resolves its upstream from `input.serverUrl` when `OPENCODE_MOBILE_UPSTREAM` is unset, so the desktop's rotating port is followed automatically.

The desktop binds a random port each launch. `PluginInput` exposes the live URL (`packages/opencode/src/plugin/index.ts:165-167`), so the plugin should default to it rather than to `4096`.

- [ ] **Step 1: Write the failing test**

Append to `packages/mobile-gateway/test/plugin.test.ts`:

```ts
  test("uses the provided serverUrl as the upstream fallback", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("from-serve-url", { headers: { "content-type": "text/plain" } }),
    })
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousMobile = process.env.OPENCODE_MOBILE_PASSWORD
    const previousUpstream = process.env.OPENCODE_MOBILE_UPSTREAM
    const previousHost = process.env.OPENCODE_MOBILE_HOST
    const previousPort = process.env.OPENCODE_MOBILE_PORT

    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    process.env.OPENCODE_MOBILE_PASSWORD = "phone"
    process.env.OPENCODE_MOBILE_HOST = "127.0.0.1"
    process.env.OPENCODE_MOBILE_PORT = "0"
    delete process.env.OPENCODE_MOBILE_UPSTREAM

    const hooks = await mobileGateway.server({
      ...input,
      serverUrl: new URL(`http://127.0.0.1:${upstream.port}`),
    })
    expect(hooks.dispose).toBeInstanceOf(Function)

    const restore = () => {
      if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
      if (previousMobile === undefined) delete process.env.OPENCODE_MOBILE_PASSWORD
      else process.env.OPENCODE_MOBILE_PASSWORD = previousMobile
      if (previousUpstream === undefined) delete process.env.OPENCODE_MOBILE_UPSTREAM
      else process.env.OPENCODE_MOBILE_UPSTREAM = previousUpstream
      if (previousHost === undefined) delete process.env.OPENCODE_MOBILE_HOST
      else process.env.OPENCODE_MOBILE_HOST = previousHost
      if (previousPort === undefined) delete process.env.OPENCODE_MOBILE_PORT
      else process.env.OPENCODE_MOBILE_PORT = previousPort
    }
    restore()

    await hooks.dispose?.()
    upstream.stop(true)
  })
```

This test asserts the plugin still starts cleanly when driven by `serverUrl`; the upstream routing itself is covered by Task 3's `resolveOptions` tests, since the plugin exposes no port to the test.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/plugin.test.ts` from `packages/mobile-gateway`
Expected: FAIL if the plugin still reads `OPENCODE_MOBILE_UPSTREAM` only, because the fallback is not wired.

- [ ] **Step 3: Implement**

In `src/index.ts`:

```ts
async function server(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const env = { ...process.env }
  if (typeof options?.password === "string" && options.password) env.OPENCODE_MOBILE_PASSWORD = options.password
  const resolved = resolveOptions(env, input.serverUrl?.toString())
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
```

Plugin options take precedence over the environment so a user can declare the phone password in config. `input.serverUrl` is typed as a non-optional `URL` in `PluginInput`, so `?.` is defensive only; keep it and note that in the report if a reviewer questions it.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `bun test` and `bun typecheck` from `packages/mobile-gateway`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile-gateway/src/index.ts packages/mobile-gateway/test/plugin.test.ts
git commit -m "feat(mobile-gateway): default the upstream to the live server URL"
```

---

### Task 5: Documentation and desktop install

**Files:**
- Modify: `packages/mobile-gateway/README.md`
- Create: project-level opencode config entry (see Step 3)

**Interfaces:**
- Consumes: everything above.
- Produces: accurate docs for the desktop workflow, and a working install in the user's own config.

- [ ] **Step 1: Update the README**

Document, accurately:

- `OPENCODE_MOBILE_PASSWORD` is the phone's credential. When set, it must be stable across desktop restarts. When unset, the gateway falls back to `OPENCODE_SERVER_PASSWORD`.
- The upstream hop uses `OPENCODE_SERVER_PASSWORD`, which the desktop rotates each launch; the phone never sees it.
- The desktop binds a random port each launch, so leave `OPENCODE_MOBILE_UPSTREAM` unset and let the plugin follow `serverUrl`.
- Running under the desktop app requires the built app to include this package; when running from source use `bun run dev`.
- Under the desktop's Electron Node runtime there is no `Bun` global; the gateway uses `node:http`, which works in both runtimes.
- Keep the existing Security section, and add the stable-password guidance: choose a long value for `OPENCODE_MOBILE_PASSWORD`, since it is the phone's only credential and does not rotate.

- [ ] **Step 2: Verify the package loads under both runtimes**

Run from `packages/mobile-gateway`:
```bash
bun test test/node-runtime.test.ts
bun test
bun typecheck
```
Expected: the Electron runtime test prints `NODE_RUNTIME_OK`, the suite passes, typecheck is clean.

- [ ] **Step 3: Install for the user's desktop app**

Verified during planning: the desktop app loads plugins by **dynamic import at runtime**, so a packaged app can load this repo's source directly. Electron's utility process (where the sidecar server runs) natively loads `.ts` files with `.ts`-extension imports — confirmed by forking a real utility process that imported a `.ts` module successfully. No app rebuild is required.

Add the plugin to the global config, using the tuple form so the phone password lives in config rather than requiring an environment variable on the desktop:

```json
{
  "plugin": [
    ["file:///home/yeager1977/GitHub/flynncode/packages/mobile-gateway", { "password": "<chosen-phone-password>" }]
  ]
}
```

Global config path: `~/.config/opencode/opencode.jsonc`. Preserve every existing field and existing `plugin` entry.

If the user prefers not to store the password in config, omit the options object and set `OPENCODE_MOBILE_PASSWORD` in the desktop app's environment instead; the plugin falls back to it.

- [ ] **Step 4: Report the restart requirement**

Config is loaded once at startup. The user must quit and restart the app for the plugin to load. State this explicitly in the completion report.

---

## Verification

Automated:
- `bun test` from `packages/mobile-gateway` — all tests pass.
- `bun typecheck` from `packages/mobile-gateway` — clean.
- `bun test test/node-runtime.test.ts` — proves the package loads and serves under Electron's Node with no `Bun` global.
- `grep -rn "Bun\." packages/mobile-gateway/src/` — no output.

Manual, on the user's machine:
- Start the desktop app with `OPENCODE_MOBILE_PASSWORD` set in its environment.
- Confirm the log line `[mobile-gateway] listening on http://0.0.0.0:4097`.
- From a desktop browser, `http://127.0.0.1:4097` prompts for credentials; the mobile password works and the server password is rejected.
- Open `http://<lan-ip>:4097` on the phone and complete the checklist from the original plan.
