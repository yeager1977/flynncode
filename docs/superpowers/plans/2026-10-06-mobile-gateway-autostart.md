# Mobile Gateway Auto-Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop sidecar auto-starts `@flynncode/mobile-gateway` on port 4097 with a persisted stable phone password, so the Settings Phone card reports running without any user plugin config.

**Architecture:** Main process generates-or-loads a stable phone password from electron-store and passes it to the sidecar via an extended `StartCommand`; the sidecar starts the gateway next to `Server.listen` with `resolveOptions`/`startGateway` bundled in, and stops it on shutdown. Fixed port 4097, v1 sidecar only.

**Tech Stack:** TypeScript, Electron main + utilityProcess sidecar, electron-store, `@flynncode/mobile-gateway` (bundled via electron-vite), Bun test.

## Global Constraints

- No `any` type; prefer `const`, early returns over `else`, dot notation over destructuring.
- Never use star imports or aliased imports (inline `type` qualifiers like `import { foo, type Bar }` are allowed).
- NEVER hardcode user-visible English strings in production code; new UI copy needs i18n keys (this plan adds no UI copy).
- Tests run from package dirs (`bun test <file>` from `packages/desktop`); typecheck via `bun run typecheck` from package dirs, never `tsc` directly.
- Avoid mocks; test real functions and real listeners.
- Sidecar code must run under Electron's Node utilityProcess (node builtins + globals only, no Bun APIs, no Electron renderer APIs).
- v1 sidecar path only (`SIDECAR_VERSION === "v1"` default); v2 `startBackgroundCli` path is out of scope.

---

### Task 1: Stable phone password store helper

**Files:**
- Modify: `packages/desktop/src/main/store-keys.ts`
- Create: `packages/desktop/src/main/mobile-password.ts`
- Test: `packages/desktop/src/main/mobile-password.test.ts`

**Interfaces:**
- Consumes: `MOBILE_PHONE_PASSWORD_KEY` from `store-keys.ts`
- Produces: `PasswordStore` type `{ get(key: string): string | undefined; set(key: string, value: string): void }`, `getOrCreateMobilePhonePassword(store: PasswordStore, key: string, generate: () => string): string`

- [ ] **Step 1: Add the store key**

In `packages/desktop/src/main/store-keys.ts`, append:

```ts
export const MOBILE_PHONE_PASSWORD_KEY = "mobilePhonePassword"
```

- [ ] **Step 2: Write the failing test**

Create `packages/desktop/src/main/mobile-password.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { getOrCreateMobilePhonePassword, type PasswordStore } from "./mobile-password"
import { MOBILE_PHONE_PASSWORD_KEY } from "./store-keys"

function memoryStore(initial?: Record<string, string>): PasswordStore & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    data,
    get: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value)
    },
  }
}

describe("getOrCreateMobilePhonePassword", () => {
  test("reuses the persisted password without generating", () => {
    const store = memoryStore({ [MOBILE_PHONE_PASSWORD_KEY]: "phone-secret" })
    let generated = 0
    const result = getOrCreateMobilePhonePassword(store, MOBILE_PHONE_PASSWORD_KEY, () => {
      generated += 1
      return "new-secret"
    })
    expect(result).toBe("phone-secret")
    expect(generated).toBe(0)
  })

  test("generates and persists when missing", () => {
    const store = memoryStore()
    const result = getOrCreateMobilePhonePassword(store, MOBILE_PHONE_PASSWORD_KEY, () => "fresh-secret")
    expect(result).toBe("fresh-secret")
    expect(store.data.get(MOBILE_PHONE_PASSWORD_KEY)).toBe("fresh-secret")
  })

  test("treats empty string as missing", () => {
    const store = memoryStore({ [MOBILE_PHONE_PASSWORD_KEY]: "" })
    const result = getOrCreateMobilePhonePassword(store, MOBILE_PHONE_PASSWORD_KEY, () => "fresh-secret")
    expect(result).toBe("fresh-secret")
    expect(store.data.get(MOBILE_PHONE_PASSWORD_KEY)).toBe("fresh-secret")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/main/mobile-password.test.ts`
Expected: FAIL with "Cannot find module './mobile-password'"

- [ ] **Step 4: Write minimal implementation**

Create `packages/desktop/src/main/mobile-password.ts`:

```ts
export type PasswordStore = {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export function getOrCreateMobilePhonePassword(store: PasswordStore, key: string, generate: () => string) {
  const existing = store.get(key)
  if (existing) return existing
  const next = generate()
  store.set(key, next)
  return next
}
```

This module must not import Electron or `./store` (electron-store crashes under plain `bun test`); the Electron-backed adapter is built inline at the call site in Task 2.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/main/mobile-password.test.ts`
Expected: PASS (3 pass, 0 fail)

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/main/store-keys.ts packages/desktop/src/main/mobile-password.ts packages/desktop/src/main/mobile-password.test.ts
git commit -m "feat(desktop): add stable mobile phone password helper"
```

### Task 2: Sidecar auto-starts the gateway

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `packages/mobile-gateway/package.json`
- Create: `packages/desktop/src/main/mobile-gateway-launch.ts`
- Test: `packages/desktop/src/main/mobile-gateway-launch.test.ts`
- Modify: `packages/desktop/src/main/sidecar.ts`
- Modify: `packages/desktop/src/main/server.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Lockfile: `bun.lock` (regenerated by `bun install`)

**Interfaces:**
- Consumes: `MOBILE_PHONE_PASSWORD_KEY` + `getOrCreateMobilePhonePassword` from Task 1; `resolveOptions` from `@flynncode/mobile-gateway`; `startGateway` from `@flynncode/mobile-gateway/gateway` (new export below)
- Produces: `MOBILE_GATEWAY_PORT = 4097`, `mobileGatewayUpstream(hostname, port): string`, `mobileGatewayEnv(...): Record<string, string>`, `MobileGatewayHandle = { port: number; stop(): void }`, `startMobileGateway(...): Promise<MobileGatewayHandle | undefined>` (never throws; undefined means disabled or failed)

- [ ] **Step 1: Add the gateway subpath export**

In `packages/mobile-gateway/package.json`, extend `exports`:

```json
"exports": {
  ".": "./src/config.ts",
  "./server": "./src/index.ts",
  "./gateway": "./src/gateway.ts"
},
```

`src/gateway.ts` imports only relative siblings plus node builtins, so it bundles cleanly into the Electron sidecar.

- [ ] **Step 2: Add the desktop dependency and install**

In `packages/desktop/package.json` `dependencies`, add as the first entry (alphabetical):

```json
"@flynncode/mobile-gateway": "workspace:*",
```

Run: `bun install`
Expected: `@flynncode/mobile-gateway` links; `bun.lock` updates. Commit the lockfile with the task.

- [ ] **Step 3: Write the failing test**

Create `packages/desktop/src/main/mobile-gateway-launch.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import {
  MOBILE_GATEWAY_PORT,
  mobileGatewayEnv,
  mobileGatewayUpstream,
  startMobileGateway,
  type MobileGatewayHandle,
} from "./mobile-gateway-launch"

describe("mobileGatewayUpstream", () => {
  test("builds upstream from sidecar host and port", () => {
    expect(mobileGatewayUpstream("127.0.0.1", 51234)).toBe("http://127.0.0.1:51234")
  })
})

describe("mobileGatewayEnv", () => {
  test("maps passwords and port to gateway env", () => {
    expect(mobileGatewayEnv({ serverPassword: "upstream", phonePassword: "phone", port: 4097 })).toEqual({
      OPENCODE_SERVER_PASSWORD: "upstream",
      OPENCODE_MOBILE_PASSWORD: "phone",
      OPENCODE_MOBILE_PORT: "4097",
    })
  })
})

describe("startMobileGateway", () => {
  const handles: MobileGatewayHandle[] = []
  afterEach(() => {
    while (handles.length) handles.pop()?.stop()
  })

  test("starts a gateway on an ephemeral port and serves status", async () => {
    expect(MOBILE_GATEWAY_PORT).toBe(4097)
    const handle = await startMobileGateway({
      serverPassword: "upstream-secret",
      phonePassword: "phone-secret",
      port: 0,
      upstream: "http://127.0.0.1:9",
    })
    expect(handle).toBeDefined()
    if (!handle) return
    handles.push(handle)
    const response = await fetch(`http://127.0.0.1:${handle.port}/flynncode-mobile-status`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { launcherUrls: unknown }
    expect(Array.isArray(body.launcherUrls)).toBe(true)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test src/main/mobile-gateway-launch.test.ts`
Expected: FAIL with "Cannot find module './mobile-gateway-launch'"

- [ ] **Step 5: Write the launch module**

Create `packages/desktop/src/main/mobile-gateway-launch.ts`:

```ts
import { resolveOptions } from "@flynncode/mobile-gateway"
import { startGateway } from "@flynncode/mobile-gateway/gateway"

export const MOBILE_GATEWAY_PORT = 4097

export function mobileGatewayUpstream(hostname: string, port: number) {
  return `http://${hostname}:${port}`
}

export function mobileGatewayEnv(input: { serverPassword: string; phonePassword: string; port: number }) {
  return {
    OPENCODE_SERVER_PASSWORD: input.serverPassword,
    OPENCODE_MOBILE_PASSWORD: input.phonePassword,
    OPENCODE_MOBILE_PORT: String(input.port),
  }
}

export type MobileGatewayHandle = { port: number; stop(): void }

export async function startMobileGateway(input: {
  serverPassword: string
  phonePassword: string
  port: number
  upstream: string
}): Promise<MobileGatewayHandle | undefined> {
  const resolved = resolveOptions(mobileGatewayEnv(input), input.upstream)
  if (!resolved.ok) {
    console.warn(`[mobile-gateway] disabled: ${resolved.reason}`)
    return
  }
  try {
    const gateway = await startGateway({ options: resolved.value })
    console.log(`[mobile-gateway] listening on http://${resolved.value.host}:${gateway.port}`)
    return gateway
  } catch (error) {
    console.warn(`[mobile-gateway] failed to start: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/main/mobile-gateway-launch.test.ts`
Expected: PASS. If `@flynncode/mobile-gateway` does not resolve under `bun test`, re-run `bun install` from the repo root and retry; do not change the import.

- [ ] **Step 7: Wire the sidecar**

In `packages/desktop/src/main/sidecar.ts`:

1. Extend `StartCommand`:

```ts
type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  mobile: { password: string; port: number }
}
```

2. Extend `parseCommand` validation (after the existing `userDataPath` check, before the return):

```ts
const mobile = (command as { mobile?: unknown }).mobile
if (!mobile || typeof mobile !== "object") return
const mobilePassword = (mobile as { password?: unknown }).password
const mobilePort = (mobile as { port?: unknown }).port
if (typeof mobilePassword !== "string" || mobilePassword === "") return
if (typeof mobilePort !== "number" || !Number.isInteger(mobilePort) || mobilePort < 0 || mobilePort > 65535) {
  return
}
```

and include `mobile: { password: mobilePassword, port: mobilePort }` in the returned object.

3. Add imports:

```ts
import {
  mobileGatewayUpstream,
  startMobileGateway,
  type MobileGatewayHandle,
} from "./mobile-gateway-launch"
```

4. Add module state next to `listener`:

```ts
let mobileGateway: MobileGatewayHandle | undefined
```

5. In `start()`, after `listener = await Server.listen({...})` and before `parentPort.postMessage({ type: "ready" })`, add:

```ts
mobileGateway = await startMobileGateway({
  serverPassword: command.password,
  phonePassword: command.mobile.password,
  port: command.mobile.port,
  upstream: mobileGatewayUpstream(command.hostname, command.port),
})
```

A port conflict or disabled config resolves to `undefined` and the sidecar keeps running; the Phone card then correctly shows stopped.

6. In `stop()`, first line of the try block:

```ts
mobileGateway?.stop()
mobileGateway = undefined
```

- [ ] **Step 8: Plumb the password through server.ts and index.ts**

In `packages/desktop/src/main/server.ts`:

1. Add import:

```ts
import { MOBILE_GATEWAY_PORT } from "./mobile-gateway-launch"
```

2. Extend `SpawnLocalServerOptions`:

```ts
type SpawnLocalServerOptions = {
  userDataPath: string
  mobilePassword: string
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}
```

3. In the `child.postMessage` call, add:

```ts
mobile: { password: options.mobilePassword, port: MOBILE_GATEWAY_PORT },
```

In `packages/desktop/src/main/index.ts`:

1. Add imports:

```ts
import { MOBILE_PHONE_PASSWORD_KEY } from "./store-keys"
import { getOrCreateMobilePhonePassword } from "./mobile-password"
import { getStore } from "./store"
```

2. After `const password = randomUUID()` (sidecar v1 path, before `spawnLocalServer`), add:

```ts
const persisted = getStore()
const mobilePassword = getOrCreateMobilePhonePassword(
  {
    get: (key) => {
      const value = persisted.get(key)
      return typeof value === "string" && value ? value : undefined
    },
    set: (key, value) => persisted.set(key, value),
  },
  MOBILE_PHONE_PASSWORD_KEY,
  randomUUID,
)
```

3. Pass `mobilePassword` in the `spawnLocalServer` options object.

- [ ] **Step 9: Run tests and typecheck**

Run: `bun test src/main/mobile-password.test.ts src/main/mobile-gateway-launch.test.ts`
Expected: PASS

The mobile-gateway sources use explicit `.ts` extension imports (Electron-Node
convention). Desktop's `tsgo -b` rejects them unless
`allowImportingTsExtensions` is enabled, so add one line to the
`compilerOptions` in `packages/desktop/tsconfig.json` (valid here because
`noEmit` is already true; typecheck-only, no build output change):

```json
"allowImportingTsExtensions": true,
```

Run: `bun run typecheck`
Expected: PASS

If `bun install` flipped `packages/mobile-gateway/src/bin.ts` to mode 755,
revert the mode-only change (`chmod 644 packages/mobile-gateway/src/bin.ts`)
to keep the diff clean.

- [ ] **Step 10: Bundle the gateway and verify**

electron-vite externalizes workspace deps by default, which would leave a bare
`@flynncode/mobile-gateway` import in the output (unresolvable at runtime
since the package exports `.ts` source). Force bundling with one line in
`packages/desktop/electron.vite.config.ts`, changing:

```ts
externalizeDeps: { include: [nodePtyPkg] },
```

to:

```ts
externalizeDeps: { include: [nodePtyPkg], exclude: ["@flynncode/mobile-gateway"] },
```

Run: `bun run build`
Expected: PASS. Then:

Run: `grep -rl "flynncode-mobile-status" out/main/`
Expected: at least one match (Rollup code-splits the shared launch module
into `out/main/chunks/`; the match may be in a chunk rather than `sidecar.js`
itself, which is fine). Then:

Run: `grep -r "@flynncode/mobile-gateway" out/main/ || echo "no bare imports"`
Expected: `no bare imports` (nothing left externalized).

If the first grep returns nothing, the import was tree-shaken or unresolved:
inspect `out/main/` for bare remnants and fix resolution before proceeding
(do not continue with an unbundled gateway).

- [ ] **Step 11: Commit**

```bash
git add packages/desktop/package.json packages/desktop/tsconfig.json packages/desktop/electron.vite.config.ts packages/mobile-gateway/package.json bun.lock packages/desktop/src/main/mobile-gateway-launch.ts packages/desktop/src/main/mobile-gateway-launch.test.ts packages/desktop/src/main/sidecar.ts packages/desktop/src/main/server.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): auto-start mobile gateway in sidecar"
```

### Task 3: Docs and acceptance

**Files:**
- Modify: `packages/mobile-gateway/README.md`
- Modify: `docs/superpowers/specs/2026-10-06-mobile-lan-onboarding-design.md`

- [ ] **Step 1: Rewrite the desktop section of the README**

In `packages/mobile-gateway/README.md`, replace the whole `## Run in the desktop app` section with:

```md
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
```

Keep every other section byte-for-byte.

- [ ] **Step 2: Note the spec deviation**

At the end of `docs/superpowers/specs/2026-10-06-mobile-lan-onboarding-design.md`, append:

```md
## Update (2026-10-06): sidecar auto-start replaces plugin loading

The Architecture section above assumed the desktop loads this package as a
plugin. That was never implemented: no desktop code referenced the package and
no user config includes it, so port 4097 stayed closed and the Phone card
correctly showed stopped. The desktop now auto-starts the gateway inside its
sidecar (`packages/desktop/src/main/sidecar.ts` via
`mobile-gateway-launch.ts`) with a stable phone password persisted in the
desktop settings store. The `mdnsUrl` field remains deferred as documented in
the final review.
```

- [ ] **Step 3: Headless acceptance**

Run: `bun test --timeout 30000` from `packages/mobile-gateway`
Expected: PASS (125 tests)

Run from `packages/mobile-gateway` with a down upstream and ephemeral port:

```bash
OPENCODE_SERVER_PASSWORD=headless-test OPENCODE_MOBILE_PASSWORD=headless-phone OPENCODE_MOBILE_PORT=0 bun run src/bin.ts
```

Expected: logs `listening on` plus `phone:` launcher URLs. Stop with Ctrl-C. Then:

Run: `curl -s -m 3 http://127.0.0.1:4097/flynncode-mobile-status || echo "gateway correctly absent when not started"`
Expected: the absent message (nothing is running headless outside the test above).

Real-device pass is deferred to the user: install the rebuilt deb, open Settings > Servers, confirm the Phone card is green with QR, scan it, confirm `/m` loads with Running-now visible, send a prompt from phone Safari.

- [ ] **Step 4: Commit**

```bash
git add packages/mobile-gateway/README.md docs/superpowers/specs/2026-10-06-mobile-lan-onboarding-design.md
git commit -m "docs(mobile-gateway): document sidecar auto-start"
```
