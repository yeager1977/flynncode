# Mobile LAN Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop shows scannable phone URLs for the LAN gateway so monitor-plus-prompt works without typing an IP.

**Architecture:** Gateway computes LAN IPs and serves a localhost-only status route; desktop main exposes it over existing IPC; Servers tab renders a Phone card with URLs, QR, and copy.

**Tech Stack:** TypeScript, `node:http`, `node:os`, Bun test, Electron main/preload, SolidJS settings UI.

## Global Constraints

- NEVER hardcode user-visible English strings in desktop or app production code; ALWAYS use an i18n key, preserve existing English byte-for-byte.
- Renderer process only calls `window.api` from `src/preload`; main registers IPC handlers in `src/main/ipc.ts`.
- No `any` type; prefer `const`, early returns over `else`, dot notation over destructuring.
- Never use star imports or aliased imports.
- Tests cannot run from repo root; run `bun test` and `bun typecheck` from package dirs (`packages/mobile-gateway`, `packages/desktop`, `packages/app`).
- Avoid mocks; test real listeners and real functions.

---

### Task 1: Gateway LAN IP discovery

**Files:**
- Create: `packages/mobile-gateway/src/lan-ips.ts`
- Test: `packages/mobile-gateway/test/lan-ips.test.ts`

**Interfaces:**
- Consumes: `node:os.networkInterfaces()`
- Produces: `listLanIPv4(interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[]`, `buildLauncherUrls(ips: string[], port: number): string[]`, `buildStatusPayload(input: { port: number; ips: string[] }): { port: number; lanUrls: string[]; launcherUrls: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { buildLauncherUrls, listLanIPv4 } from "../src/lan-ips"

describe("listLanIPv4", () => {
  test("keeps LAN IPv4, drops loopback, internal, and IPv6", () => {
    const result = listLanIPv4({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      eth0: [
        { address: "192.168.1.42", family: "IPv4", internal: false } as never,
        { address: "fe80::1", family: "IPv6", internal: false } as never,
      ],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false } as never],
    })
    expect(result).toEqual(["172.17.0.1", "192.168.1.42"])
  })

  test("builds launcher urls with /m path", () => {
    expect(buildLauncherUrls(["192.168.1.42"], 4097)).toEqual(["http://192.168.1.42:4097/m"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/lan-ips.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```ts
import type { NetworkInterfaceInfo } from "node:os"
import { networkInterfaces } from "node:os"

export function listLanIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()) {
  const found: string[] = []
  for (const list of Object.values(interfaces)) {
    if (!list) continue
    for (const info of list) {
      if (info.family !== "IPv4") continue
      if (info.internal) continue
      if (info.address.startsWith("127.")) continue
      if (info.address.startsWith("169.254.")) continue
      found.push(info.address)
    }
  }
  return [...new Set(found)].sort()
}

export function buildLauncherUrls(ips: string[], port: number) {
  return ips.map((ip) => `http://${ip}:${port}/m`)
}

export function buildStatusPayload(input: { port: number; ips: string[] }) {
  return {
    port: input.port,
    lanUrls: input.ips.map((ip) => `http://${ip}:${input.port}`),
    launcherUrls: buildLauncherUrls(input.ips, input.port),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/lan-ips.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/mobile-gateway/src/lan-ips.ts packages/mobile-gateway/test/lan-ips.test.ts
git commit -m "feat(mobile-gateway): add LAN IP discovery"
```

### Task 2: Gateway status route and log lines

**Files:**
- Modify: `packages/mobile-gateway/src/gateway.ts`
- Modify: `packages/mobile-gateway/src/index.ts`
- Modify: `packages/mobile-gateway/src/bin.ts`
- Test: `packages/mobile-gateway/test/gateway.test.ts`

**Interfaces:**
- Consumes: `buildStatusPayload` and `listLanIPv4` from Task 1, `createGateway` handle from `src/gateway.ts`
- Produces: localhost-only `GET /flynncode-mobile-status` returning status JSON; startup logs with real LAN launcher URLs

- [ ] **Step 1: Write the failing test**

Add to `packages/mobile-gateway/test/gateway.test.ts`, following the existing
`createGateway` handler pattern (no network needed):

```ts
test("serves localhost mobile status without upstream contact", async () => {
  upstreamRequests = []
  const handle = createGateway({ options })
  const response = await handle(new Request("http://127.0.0.1/flynncode-mobile-status"))
  expect(response.status).toBe(200)
  const body = (await response.json()) as { port: number; lanUrls: string[]; launcherUrls: string[] }
  expect(body.port).toBe(options.port)
  expect(body.launcherUrls.every((url) => url.endsWith("/m"))).toBe(true)
  expect(upstreamRequests).toEqual([])
})
```

- [ ] **Step 2: Run test to verify current behavior lacks the route**

Run: `bun test test/gateway.test.ts`
Expected: new assertion FAILs (404 or missing body)

- [ ] **Step 3: Write minimal implementation**

In `src/gateway.ts`, add a static import matching the existing style:

```ts
import { buildStatusPayload, listLanIPv4 } from "./lan-ips.ts"
```

In `createGateway` handle, before the launcher branch, add:

```ts
if (new URL(request.url, "http://localhost").pathname === "/flynncode-mobile-status") {
  const host = new URL(request.url, "http://localhost").hostname
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    return new Response("Not found", { status: 404 })
  }
  const payload = buildStatusPayload({ port: options.port, ips: listLanIPv4() })
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
```

In `src/index.ts` and `src/bin.ts`, add a static import and log each launcher URL after `startGateway`:

```ts
import { buildLauncherUrls, listLanIPv4 } from "./lan-ips.ts"
for (const url of buildLauncherUrls(listLanIPv4(), gateway.port)) {
  console.log(`[mobile-gateway] phone: ${url}`)
}
```

Keep the existing `listening on` line unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --timeout 30000`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/mobile-gateway/src/gateway.ts packages/mobile-gateway/src/index.ts packages/mobile-gateway/src/bin.ts packages/mobile-gateway/test/gateway.test.ts
git commit -m "feat(mobile-gateway): expose localhost status and log phone URLs"
```

### Task 3: Desktop main IPC for mobile status

**Files:**
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/types.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Test: `packages/desktop/src/main/index.test.ts` (only if an IPC registration test already exists there; otherwise manual verify)

**Interfaces:**
- Consumes: gateway `GET http://127.0.0.1:4097/flynncode-mobile-status`
- Produces: `window.api.getMobileGatewayStatus(): Promise<{ running: boolean; port: number; lanUrls: string[]; launcherUrls: string[] }>`

- [ ] **Step 1: Add preload type**

```ts
export type MobileGatewayStatus = {
  running: boolean
  port: number
  lanUrls: string[]
  launcherUrls: string[]
}
```

Add to `ElectronAPI`: `getMobileGatewayStatus: () => Promise<MobileGatewayStatus>`.

- [ ] **Step 2: Add preload bridge**

```ts
getMobileGatewayStatus: () => ipcRenderer.invoke("get-mobile-gateway-status"),
```

- [ ] **Step 3: Add main handler in `registerIpcHandlers`**

```ts
ipcMain.handle("get-mobile-gateway-status", async () => {
  try {
    const response = await fetch("http://127.0.0.1:4097/flynncode-mobile-status", {
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return { running: false, port: 4097, lanUrls: [], launcherUrls: [] }
    const data = (await response.json()) as { port: number; lanUrls: string[]; launcherUrls: string[] }
    return { running: true, ...data }
  } catch {
    return { running: false, port: 4097, lanUrls: [], launcherUrls: [] }
  }
})
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck`
Expected: PASS. Manual: desktop dev start, call `window.api.getMobileGatewayStatus()` from devtools, confirm `running` matches gateway state.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/ipc.ts packages/desktop/src/preload/types.ts packages/desktop/src/preload/index.ts
git commit -m "feat(desktop): expose mobile gateway status over IPC"
```

### Task 4: Servers Phone card UI

**Files:**
- Create: `packages/app/src/components/settings-v2/phone-card.tsx`
- Modify: `packages/app/src/components/settings-v2/servers.tsx`
- Modify: `packages/app/src/i18n/en.ts` (and only en; other locales fall back)
- Test: `packages/app/src/components/settings-v2/phone-card.test.tsx` (follow existing `bun test --conditions=solid --preload ./happydom.ts ./src` pattern)

**Interfaces:**
- Consumes: `window.api.getMobileGatewayStatus()`
- Produces: `<PhoneCard />` rendered at top of Servers tab showing status, URLs, QR canvas, copy button

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/components/settings-v2/phone-card.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test"

describe("phone launcher url", () => {
  test("launcher url ends with /m", () => {
    expect("http://192.168.1.42:4097/m".endsWith("/m")).toBe(true)
  })

  test("required i18n keys exist in en module", async () => {
    const mod = (await import("@/i18n/en")) as Record<string, unknown>
    const text = JSON.stringify(mod)
    for (const key of ["server.phone.title", "server.phone.hint", "server.phone.copy", "server.phone.stopped"]) {
      expect(text.includes(key), key).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails or is placeholder**

Run: `bun test --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/phone-card.test.tsx`
Expected: FAIL (file missing)

- [ ] **Step 3: Write minimal implementation**

Component outline (follow `SettingsListV2` + `useLanguage` pattern from `servers.tsx`):

```tsx
import { type Component, createResource, Show, For } from "solid-js"
import { useLanguage } from "@/context/language"

export const PhoneCard: Component = () => {
  const language = useLanguage()
  const [status] = createResource(async () => {
    const api = (window as unknown as { api?: { getMobileGatewayStatus?: () => Promise<unknown> } }).api
    if (!api?.getMobileGatewayStatus) return { running: false, launcherUrls: [] as string[] }
    return api.getMobileGatewayStatus() as Promise<{ running: boolean; launcherUrls: string[] }>
  })
  return <div>{/* status dot, For each launcherUrls, canvas QR for first url, copy button, hint */}</div>
}
```

Rules: all visible copy via `language.t("...")` keys added to `en.json` (e.g. `server.phone.title`, `server.phone.hint`, `server.phone.copy`, `server.phone.stopped`); QR drawn client-side to `<canvas>` with no network fetch (prefer existing dep or tiny vendored encoder); copy uses `navigator.clipboard.writeText`; no password displayed.

Mount `<PhoneCard />` at the top of `SettingsServersV2` body in `servers.tsx`.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/phone-card.test.tsx`
Expected: PASS

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Manual verify**

Backend: `bun run ./src/index.ts serve --port 4096` from `packages/flynncode`. App: `bun dev -- --port 4444` from `packages/app`. Open `http://localhost:4444`, Settings > Servers, confirm card shows gateway URLs.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/components/settings-v2/phone-card.tsx packages/app/src/components/settings-v2/servers.tsx packages/app/src/i18n/en.ts packages/app/src/components/settings-v2/phone-card.test.tsx
git commit -m "feat(app): add phone connection card to servers settings"
```

### Task 5: Docs and acceptance

**Files:**
- Modify: `packages/mobile-gateway/README.md`

- [ ] **Step 1: Update onboarding steps**

Replace "Open `http://<machine-lan-ip>:4097`" with: Desktop Settings > Servers > Phone card → scan QR for `/m` → enter phone password once → Share → Add to Home Screen. Note `flynncode.local:4097` best-effort fallback.

- [ ] **Step 2: Manual acceptance**

Same WiFi: scan QR from desktop, `/m` launcher loads, Running-now visible, send a prompt from phone Safari, approve if prompted. Confirm no IP typed.

- [ ] **Step 3: Commit**

```bash
git add packages/mobile-gateway/README.md
git commit -m "docs(mobile-gateway): document QR phone onboarding"
```
