# Phone Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phone gets reliable needs-input/approval delivery over LAN direct plus deepthought relay for off-LAN, reusing the gateway, Phone card, and QR pairing with no vendor cloud.

**Architecture:** Extend the LAN gateway with a needs-input inbox endpoint plus launcher badge; advertise the Tailscale IP as a second direct path; add a desktop-to-deepthought digest publisher plus a deepthought-hosted relay inbox so the phone can see "needs input" while away, with approvals always executed on the origin gateway.

**Tech Stack:** Bun + TypeScript, mobile-gateway (`node:http`, global `fetch`), SolidJS Phone card, desktop Electron main, existing `permission.asked` / `question.asked` server events, Tailscale tailnet, deepthought host 192.168.4.251.

## Global Constraints

- Backends self-hosted or user-owned only (deepthought host 192.168.4.251, Tailscale on the LAN); vendor-hosted clouds, Sites hosting, and voice products stay OUT.
- No public push platform operated by Flynncode — relay via user-owned host only.
- Extend `packages/mobile-gateway` (LAN proxy on 4097, `/m` launcher, 192.168-only IPs, sidecar auto-start, Phone card with QR) — do not rebuild it.
- UI copy via i18n keys (en only), no hardcoded English in production code.
- Never use the `any` type.
- Never use star imports or aliased imports.
- Secrets must never appear in QR codes or URLs.
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/mobile-gateway`.
- Typecheck with `bun typecheck` from package directories, never `tsc` directly.
- Use conventional commits `type(scope): summary`; branch names max three words, hyphens, no slashes.
- Default branch is `dev`.

---

### Task 1: Gateway needs-input inbox endpoint (LAN direct)

**Files:**
- Modify: `packages/mobile-gateway/src/gateway.ts`
- Modify: `packages/mobile-gateway/src/launcher.ts`
- Create: `packages/mobile-gateway/src/inbox.ts`
- Test: `packages/mobile-gateway/test/inbox.test.ts`
- Test: `packages/mobile-gateway/test/gateway.test.ts`

**Interfaces:**
- Consumes: existing `Upstream.probe`, `upstreamUrl`, `GatewayOptions`, session auth (`readCookie`, `createSessionStore`).
- Produces: `listNeedsInput(input: { upstream: string; authorization: string }): Promise<InboxLoad>`; `InboxItem = { sessionID: string; directory: string | undefined; title: string; kind: "permission" | "question"; updated: number }`; `GET /flynncode-mobile-inbox` JSON `{ items: InboxItem[] }` (same phone credential as all gateway paths, localhost-gating NOT applied).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { groupInbox } from "../src/inbox.ts"

describe("groupInbox", () => {
  test("marks permission and question kinds separately", () => {
    const items = groupInbox({
      sessions: [{ id: "ses_1", title: "Fix login", directory: "/repo/app", updated: 100 }],
      permissions: [{ sessionID: "ses_1", id: "perm_1" }],
      questions: [],
    })
    expect(items).toEqual([
      { sessionID: "ses_1", directory: "/repo/app", title: "Fix login", kind: "permission", updated: 100 },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/inbox.test.ts` (workdir `packages/mobile-gateway`)
Expected: FAIL with "Cannot find module '../src/inbox.ts'"

- [ ] **Step 3: Probe the upstream pending-permission API before implementing**

Run against a local backend (`bun run ./src/index.ts serve --port 4096` from `packages/opencode`, then inspect): `curl -s -H "authorization: Basic <base64>" "http://127.0.0.1:4096/api/session?limit=1" | head -c 2000`. Then check how `packages/app/src/context/server-session.ts:1233` (`permission.asked`) and `packages/app/src/context/global-sync/event-reducer.ts:397` get their data: confirm whether a pollable REST shape exists for pending permissions/questions per session (e.g. session detail payload carrying open permission/question requests) or whether the only source is the SSE event stream. Record the exact upstream path + JSON shape chosen in a code comment above `listNeedsInput`. If REST has no pending shape, `listNeedsInput` polls `GET <upstream>/api/session/active` plus `GET <upstream>/api/session?limit=30&order=desc` (same two sources as `loadLauncher`) and then `GET <upstream>/api/session/<id>` per active session (bounded to first 10, 5s `AbortSignal.timeout` each, `redirect: "error"`), parsing open `permissions`/`questions` arrays with the same `isRecord` guard style as `launcher.ts:145`.

- [ ] **Step 4: Write minimal implementation**

```ts
import { upstreamUrl } from "./upstream.ts"

export type InboxItem = {
  sessionID: string
  directory: string | undefined
  title: string
  kind: "permission" | "question"
  updated: number
}

export function groupInbox(input: {
  sessions: Array<{ id: string; title: string; directory: string | undefined; updated: number }>
  permissions: Array<{ sessionID: string; id: string }>
  questions: Array<{ sessionID: string; id: string }>
}): InboxItem[] {
  const known = new Map(input.sessions.map((session) => [session.id, session]))
  const items: InboxItem[] = []
  for (const request of input.permissions) {
    const session = known.get(request.sessionID)
    if (session === undefined) continue
    items.push({ sessionID: session.id, directory: session.directory, title: session.title, kind: "permission", updated: session.updated })
  }
  for (const request of input.questions) {
    const session = known.get(request.sessionID)
    if (session === undefined) continue
    items.push({ sessionID: session.id, directory: session.directory, title: session.title, kind: "question", updated: session.updated })
  }
  return items.sort((a, b) => b.updated - a.updated)
}
```

Plus `listNeedsInput` (same file) doing the bounded upstream fetch described in Step 3 with `Schema`-free `isRecord` guards (matching `launcher.ts` style), returning `{ kind: "loaded"; items: InboxItem[] } | { kind: "unauthorized" } | { kind: "unreachable" }`.

- [ ] **Step 5: Wire `GET /flynncode-mobile-inbox` into `gateway.ts` handle**

Insert after the `/flynncode-mobile-status` block, before the launcher branch: parse pathname, require the same cookie/Basic auth already established above (do not add a second auth scheme), call `listNeedsInput({ upstream: options.upstream, authorization })`, return `401` on unauthorized, `503` on unreachable, else `200` with `{ items }` JSON. Strip nothing secret: items carry only sessionID, title, directory, kind, updated — never passwords, tokens, or prompt text.

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test --timeout 30000` (workdir `packages/mobile-gateway`)
Expected: PASS. Run: `bun typecheck` (workdir `packages/mobile-gateway`)
Expected: PASS with no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/mobile-gateway/src/inbox.ts packages/mobile-gateway/src/gateway.ts packages/mobile-gateway/src/launcher.ts packages/mobile-gateway/test/inbox.test.ts packages/mobile-gateway/test/gateway.test.ts
git commit -m "feat(mobile-gateway): add needs-input inbox endpoint"
```

### Task 2: Launcher "Needs input" section + inbox badge

**Files:**
- Modify: `packages/mobile-gateway/src/launcher-html.ts`
- Modify: `packages/mobile-gateway/src/launcher.ts`
- Test: `packages/mobile-gateway/test/launcher-html.test.ts`

**Interfaces:**
- Consumes: Task 1 `InboxItem`, `LauncherData`, `relativeTime`, `projectLabel`, `sessionSlug`.
- Produces: `renderLauncher(input: { data: LauncherData; now: number; partial: boolean; inbox: InboxItem[] })`; section heading `Needs input` rendered first when inbox non-empty, each row linking to the session URL plus `?needs-input=1` query (no secret in URL).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import { renderLauncher } from "../src/launcher-html.ts"

test("renders needs-input section first", () => {
  const html = renderLauncher({
    data: { running: [], groups: [] },
    now: 1000,
    partial: false,
    inbox: [{ sessionID: "ses_1", directory: "/repo/app", title: "Fix login", kind: "permission", updated: 900 }],
  })
  expect(html).toContain("Needs input")
  expect(html.indexOf("Needs input")).toBeLessThan(html.indexOf("No recent sessions"))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/launcher-html.test.ts` (workdir `packages/mobile-gateway`)
Expected: FAIL (renderLauncher signature has no inbox param / no "Needs input" string).

- [ ] **Step 3: Write minimal implementation**

In `launcher-html.ts`, add:

```ts
import { sessionSlug } from "./launcher.ts"
import type { InboxItem } from "./inbox.ts"

function inboxRow(item: InboxItem) {
  const href = item.directory === undefined ? undefined : `/${sessionSlug(item.directory)}/session/${encodeURIComponent(item.sessionID)}?needs-input=1`
  const label = item.kind === "permission" ? "Approval needed" : "Question waiting"
  const inner = `<span class="title">${escapeHtml(item.title)}</span><span class="meta">${escapeHtml(label)}</span>`
  if (href === undefined) return `<div class="row">${inner}</div>`
  return `<a class="row" href="${escapeHtml(href)}">${inner}</a>`
}
```

Extend `renderLauncher` to accept `inbox: InboxItem[]` and prepend `section("Needs input", inbox.map(inboxRow))` when non-empty. Update the `gateway.ts` `/m` branch to call `listNeedsInput` alongside `loadLauncher` (Promise.all, inbox failure degrades to `[]`, never fails the page) and pass through.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test --timeout 30000` (workdir `packages/mobile-gateway`)
Expected: PASS. Run: `bun typecheck` (workdir `packages/mobile-gateway`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile-gateway/src/launcher-html.ts packages/mobile-gateway/src/launcher.ts packages/mobile-gateway/src/gateway.ts packages/mobile-gateway/test/launcher-html.test.ts
git commit -m "feat(mobile-gateway): show needs-input section in launcher"
```

### Task 3: Tailscale direct path (second Phone card route, no new server)

**Files:**
- Modify: `packages/mobile-gateway/src/lan-ips.ts`
- Modify: `packages/mobile-gateway/src/gateway.ts` (`/flynncode-mobile-status` payload)
- Modify: `packages/desktop/src/main/ipc.ts`
- Test: `packages/mobile-gateway/test/lan-ips.test.ts`

**Interfaces:**
- Consumes: `networkInterfaces()` dict.
- Produces: `listTailnetIPv4(interfaces?): string[]` (Tailscale `100.64.0.0/10` only); status payload `{ port, lanUrls, launcherUrls, tailnetUrls, tailnetLauncherUrls }`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import { listTailnetIPv4 } from "../src/lan-ips.ts"
import type { NetworkInterfaceInfo } from "node:os"

function nic(address: string): NetworkInterfaceInfo {
  return { address, family: "IPv4", internal: false, mac: "00:00:00:00:00:00", netmask: "255.0.0.0", cidr: null }
}

test("lists only 100.64/10 addresses", () => {
  const found = listTailnetIPv4({ tailscale0: [nic("100.90.1.2")], eth0: [nic("192.168.1.5")] })
  expect(found).toEqual(["100.90.1.2"])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/lan-ips.test.ts` (workdir `packages/mobile-gateway`)
Expected: FAIL with "listTailnetIPv4 is not a function".

- [ ] **Step 3: Write minimal implementation**

```ts
export function listTailnetIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()) {
  const found: string[] = []
  for (const list of Object.values(interfaces)) {
    if (!list) continue
    for (const info of list) {
      if (info.family !== "IPv4") continue
      if (info.internal) continue
      if (!isTailnetIPv4(info.address)) continue
      found.push(info.address)
    }
  }
  return [...new Set(found)].sort()
}

function isTailnetIPv4(address: string) {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4) return false
  if (parts[0] !== 100) return false
  if (!Number.isInteger(parts[1]) || parts[1] < 64 || parts[1] > 127) return false
  return parts.slice(2).every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
}
```

Extend `buildStatusPayload` to include `tailnetUrls` + `tailnetLauncherUrls` built from `listTailnetIPv4()`. Update `packages/desktop/src/main/ipc.ts` `stoppedMobileGatewayStatus()` and the `get-mobile-gateway-status` handler to pass the new arrays through (empty arrays when stopped). Keep the existing 192.168-only rule for `listLanIPv4` untouched so QR pairing never poisons.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test --timeout 30000` (workdir `packages/mobile-gateway`)
Expected: PASS. Run: `bun typecheck` (workdir `packages/mobile-gateway`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile-gateway/src/lan-ips.ts packages/mobile-gateway/src/gateway.ts packages/desktop/src/main/ipc.ts packages/mobile-gateway/test/lan-ips.test.ts
git commit -m "feat(mobile-gateway): advertise tailscale direct path"
```

### Task 4: Deepthought relay inbox (notify-only digest, approvals stay on origin)

**Files:**
- Create: `packages/mobile-gateway/src/relay.ts`
- Modify: `packages/mobile-gateway/src/gateway.ts`
- Modify: `packages/mobile-gateway/src/config.ts`
- Test: `packages/mobile-gateway/test/relay.test.ts`

**Interfaces:**
- Consumes: Task 1 `InboxItem`.
- Produces: `RelayDigest = { originID: string; items: InboxItem[]; updatedAt: number }`; `POST /flynncode-mobile-relay/publish` (bearer `OPENCODE_RELAY_TOKEN`, body `RelayDigest`, TTL 24h, in-memory store); `GET /flynncode-mobile-relay/inbox` (same phone credential); `createRelayStore(input?: { now?: () => number })`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import { createRelayStore } from "../src/relay.ts"

test("relay store expires digests after 24h", () => {
  let now = 1_000_000
  const store = createRelayStore({ now: () => now })
  store.publish({ originID: "laptop", items: [], updatedAt: now })
  now += 25 * 3600 * 1000
  expect(store.list()).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/relay.test.ts` (workdir `packages/mobile-gateway`)
Expected: FAIL with "Cannot find module '../src/relay.ts'".

- [ ] **Step 3: Write minimal implementation**

```ts
export type RelayDigest = {
  originID: string
  items: Array<{ sessionID: string; directory: string | undefined; title: string; kind: "permission" | "question"; updated: number }>
  updatedAt: number
}

const RELAY_TTL_MS = 24 * 3600 * 1000

export function createRelayStore(input?: { now?: () => number }) {
  const now = input?.now ?? Date.now
  const digests = new Map<string, RelayDigest>()
  return {
    publish(digest: RelayDigest) {
      if (!digest.originID) return
      digests.set(digest.originID, digest)
    },
    list(): RelayDigest[] {
      const cutoff = now() - RELAY_TTL_MS
      return [...digests.values()].filter((digest) => digest.updatedAt >= cutoff)
    },
  }
}

export function isRelayAuthorized(header: string | null, expected: string) {
  if (!expected) return false
  return header === `Bearer ${expected}`
}
```

Config: add `relayToken: env.OPENCODE_RELAY_TOKEN ?? ""` to `GatewayOptions` (empty = publish disabled, GET returns `503 relay disabled`). Gateway routes: `POST /flynncode-mobile-relay/publish` requires `Authorization: Bearer <token>`, parses body with `isRecord` guards only (no `JSON.parse` in try/catch; use `await request.json()` with content-type check, reject non-records with 400), stores via process-global relay store; `GET /flynncode-mobile-relay/inbox` requires the normal phone credential and returns `{ digests: store.list() }`. Digest fields are metadata only: sessionID, title, directory, kind, updated — never prompt text, file contents, passwords, or tokens.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test --timeout 30000` (workdir `packages/mobile-gateway`)
Expected: PASS. Run: `bun typecheck` (workdir `packages/mobile-gateway`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile-gateway/src/relay.ts packages/mobile-gateway/src/gateway.ts packages/mobile-gateway/src/config.ts packages/mobile-gateway/test/relay.test.ts
git commit -m "feat(mobile-gateway): add deepthought relay inbox"
```

### Task 5: Desktop relay publisher (laptop sidecar pushes digest to deepthought)

**Files:**
- Create: `packages/desktop/src/main/relay-publisher.ts`
- Modify: `packages/desktop/src/main/sidecar.ts`
- Test: `packages/desktop/src/main/relay-publisher.test.ts`

**Interfaces:**
- Consumes: local gateway `GET http://127.0.0.1:4097/flynncode-mobile-inbox` (phone credential from settings store), deepthought relay `POST <deepthought-url>/flynncode-mobile-relay/publish` (bearer from settings store).
- Produces: `startRelayPublisher(input: { originID: string; pollMs: number; localInboxUrl: string; remotePublishUrl: string; phonePassword: string; relayToken: string; fetchImpl?: typeof fetch }): { stop(): void }`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import { buildDigestBody } from "./relay-publisher.ts"

test("digest body carries metadata only", () => {
  const body = buildDigestBody({
    originID: "laptop",
    items: [{ sessionID: "ses_1", directory: "/repo", title: "Fix", kind: "permission", updated: 5 }],
    updatedAt: 7,
  })
  expect(body).toEqual({ originID: "laptop", items: [{ sessionID: "ses_1", directory: "/repo", title: "Fix", kind: "permission", updated: 5 }], updatedAt: 7 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/main/relay-publisher.test.ts` (workdir `packages/desktop`)
Expected: FAIL with "Cannot find module './relay-publisher.ts'".

- [ ] **Step 3: Write minimal implementation**

Publisher polls every 60s (only when at least one inbox item exists OR the previous poll published non-empty — so it also publishes the empty "all clear" once, then goes quiet): GET local inbox with Basic phone credential, POST digest to deepthought with Bearer relay token, 5s timeout each, failures logged once via `console.warn` and retried next tick (no crash, no queue growth — latest digest wins). `originID` = stable machine id already used for the phone password scope (reuse the existing desktop settings store device id; do not invent a new identity file). Deepthought URL + relay token come from the existing Settings servers entry for deepthought (user already attaches deepthought at 192.168.4.251 / its Tailscale IP) plus a new settings-store field `relayToken` generated once with `crypto.getRandomValues` (32 bytes hex, same generator style as `session.ts:defaultToken`). Wire start/stop into `sidecar.ts` alongside `startMobileGateway`; stop on sidecar shutdown.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/main/relay-publisher.test.ts` (workdir `packages/desktop`)
Expected: PASS. Run: `bun typecheck` (workdir `packages/desktop`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/relay-publisher.ts packages/desktop/src/main/relay-publisher.test.ts packages/desktop/src/main/sidecar.ts
git commit -m "feat(desktop): publish needs-input digest to deepthought"
```

### Task 6: Phone card relay section + QR pairing + i18n (en only)

**Files:**
- Modify: `packages/app/src/components/settings-v2/phone-card.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Test: `packages/app/src/components/settings-v2/phone-card.test.tsx`

**Interfaces:**
- Consumes: extended `MobileGatewayStatus` (`tailnetLauncherUrls`, relay state via new `getRelayStatus` preload/IPC or via deepthought gateway status fetch).
- Produces: Phone card sections "At home" (LAN `/m` QR as today) + "Away" (Tailscale direct URL row + deepthought relay URL row + second QR for relay `/m`), all copy through `language.t(...)`.

- [ ] **Step 1: Write the failing test**

```tsx
import { expect, test } from "bun:test"
import en from "../../i18n/en.ts"

test("relay copy keys exist in en only", () => {
  expect(en["server.phone.away.title"]).toBe("Away from home")
  expect(en["server.phone.relay.hint"]).toContain("deepthought")
})
```

(Adapt to the actual `en.ts` export shape — the assertion content is what matters: both keys exist, relay hint names deepthought, no other locale file touched.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/components/settings-v2/phone-card.test.tsx` (workdir `packages/app`)
Expected: FAIL (keys missing).

- [ ] **Step 3: Add en keys (no other locale)**

```ts
"server.phone.away.title": "Away from home",
"server.phone.away.direct": "On Tailscale, use this address to reach this computer directly.",
"server.phone.relay.title": "Needs-input relay",
"server.phone.relay.hint": "When this computer sleeps, new approval requests appear on your deepthought host. Approvals still run here.",
"server.phone.relay.stopped": "Relay is off. Add your deepthought host in Servers to turn it on.",
```

- [ ] **Step 4: Extend Phone card**

Add below the existing LAN block: an "Away from home" group showing `tailnetLauncherUrls[0]` row + copy button (same `copyUrl` helper), then a relay row showing the deepthought `/m` URL (from settings servers entry, never including any token/password — QR encodes the bare `http://<deepthought-ip>:4097/m` URL only) with its own QR canvas (`qrCanvasRelay`, same `drawQrToCanvas`). Relay section hidden when deepthought server entry absent, showing `server.phone.relay.stopped` instead. Reuse `SettingsListV2`, `Show`, `For` patterns already in the file; no new dependencies.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test src/components/settings-v2/phone-card.test.tsx` (workdir `packages/app`)
Expected: PASS. Run: `bun typecheck` (workdir `packages/app`)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/components/settings-v2/phone-card.tsx packages/app/src/i18n/en.ts packages/app/src/components/settings-v2/phone-card.test.tsx
git commit -m "feat(app): add away relay section to phone card"
```

### Task 7: Relay view on deepthought `/m` + security hardening + docs

**Files:**
- Modify: `packages/mobile-gateway/src/launcher-html.ts`
- Modify: `packages/mobile-gateway/src/gateway.ts`
- Modify: `packages/mobile-gateway/README.md`
- Test: `packages/mobile-gateway/test/gateway.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `/m` on a host with relay digests renders "Away notices" section (originID + items, tap opens nothing remote — rows are non-links with `open Tailscale` hint); QR/URL invariant tests; README relay section.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"

test("relay digest rows never render links with secrets", () => {
  const { renderRelayNotice } = await import("../src/launcher-html.ts")
  const html = renderRelayNotice({ digests: [{ originID: "laptop", items: [{ sessionID: "ses_1", directory: "/r", title: "Fix", kind: "permission", updated: 1 }], updatedAt: 2 }] })
  expect(html).toContain("laptop")
  expect(html).not.toContain("password")
  expect(html).not.toContain("token")
  expect(html).not.toContain("Bearer")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/gateway.test.ts` (workdir `packages/mobile-gateway`)
Expected: FAIL with "renderRelayNotice is not a function".

- [ ] **Step 3: Write minimal implementation**

Add `renderRelayNotice(input: { digests: RelayDigest[] })` to `launcher-html.ts`: one section per origin (`Chats on <originID> need input`), rows as non-link `<div class="row">` (deliberately no href — approval happens on the origin over Tailscale, the relay is notify-only), plus a quiet line `Open the Away address from Settings > Servers to approve`. Wire into the `/m` handler: when the relay store is non-empty, append below the local sections. Harden: `POST publish` rejects bodies over 64KB with 413; `originID` capped at 64 chars; items capped at 50 per digest (truncate oldest); strip any incoming fields outside the five allowed keys before storing.

- [ ] **Step 4: Document in README**

Append a `## Off-LAN relay (deepthought)` section: Tailscale direct address first, relay second; relay is notify-only digests (session title + kind, no prompt/file content); approvals always run on the origin computer; setup = attach deepthought in Settings servers + Tailscale on both + relay token generated once in desktop settings; QR codes carry bare `/m` URLs only, phone credential typed once, relay token never leaves the two hosts.

- [ ] **Step 5: Run full verification**

Run: `bun test --timeout 30000` (workdir `packages/mobile-gateway`)
Expected: PASS. Run: `bun typecheck` (workdir `packages/mobile-gateway`)
Expected: PASS. Run: `bun test --timeout 30000` (workdir `packages/desktop`)
Expected: PASS (or only pre-existing skips).

- [ ] **Step 6: Commit**

```bash
git add packages/mobile-gateway/src/launcher-html.ts packages/mobile-gateway/src/gateway.ts packages/mobile-gateway/README.md packages/mobile-gateway/test/gateway.test.ts
git commit -m "docs(mobile-gateway): document deepthought relay"
```

## Self-Review

- Spec coverage: report item 12 (LAN + deepthought relay, QR-paired Remote approve-on-phone, Remote Control) → Tasks 1–2 (LAN inbox + approve where the full app already runs), Task 3 (Tailscale direct = off-LAN Remote Control without a cloud), Tasks 4–5 (deepthought notify-only relay = sleep-surviving needs-input without operating a push platform), Task 6 (Phone card + QR pairing extension), Task 7 (relay view + hardening + docs). Constraint update honored: no vendor cloud, no Sites, no voice, no public push platform.
- Placeholder scan: no TBD/TODO; every step has exact commands, exact keys, exact payloads.
- Type consistency: `InboxItem` shape identical across Tasks 1, 2, 4, 5; `RelayDigest` identical in Tasks 4, 5, 7; status payload extension consistent in Tasks 3, 6.
