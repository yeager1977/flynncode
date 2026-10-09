import { afterEach, describe, expect, test } from "bun:test"
import type { Manifest, ManifestSession } from "../src/sync-decide.ts"
import type { SyncPrefs } from "../src/sync-gate.ts"
import { SYNC_RESPONSE_SIGNATURE_HEADER, signResponse, verifyRequest } from "../src/sync-sign.ts"
import { createSyncWorker, initialStatus, nextDelay, type SyncStatus } from "../src/sync-worker.ts"

const PEER_TOKEN = "e".repeat(64)

type Fake = {
  manifest: Manifest
  bundles: Map<string, { session: { id: string; time_updated: number } }>
  applied: string[]
  settings: { config: Record<string, unknown> | null; mtime: number; missing?: boolean }
  settingsApplied: unknown[]
  prefs: SyncPrefs | null
  down: boolean
  failApply: Set<string>
  busyApply: Set<string>
  staleApply: Set<string>
  writes: Array<{ path: string; body: Record<string, unknown> }>
  paused: boolean
  tamper: boolean
  peerHeaders: Array<Record<string, string>>
  reloadPending: { from: string } | null
  bundleStatus: number | null
  bundleHits: number
  bundleStatuses: Map<string, number>
  bundleLog: string[]
  onBundle: (() => void) | null
  manifestHits: number
  gate: Promise<void> | null
}

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  while (servers.length) servers.pop()?.stop(true)
})

const session = (id: string, timeUpdated: number, parentID: string | null = null): ManifestSession => ({
  id,
  parentID,
  timeUpdated,
  timeArchived: null,
  busy: false,
})

function fake(sessions: ManifestSession[], schema = "s1"): Fake {
  return {
    manifest: { schema, app: "1.0.0", sessions, tombstones: [] },
    bundles: new Map(sessions.map((item) => [item.id, { session: { id: item.id, time_updated: item.timeUpdated } }])),
    applied: [],
    settings: { config: null, mtime: 0 },
    settingsApplied: [],
    prefs: null,
    down: false,
    failApply: new Set(),
    busyApply: new Set(),
    staleApply: new Set(),
    writes: [],
    paused: false,
    tamper: false,
    peerHeaders: [],
    reloadPending: null,
    bundleStatus: null,
    bundleHits: 0,
    bundleStatuses: new Map(),
    bundleLog: [],
    onBundle: null,
    manifestHits: 0,
    gate: null,
  }
}

// The local server takes Basic auth; the peer gateway takes requests signed
// with PEER_TOKEN and signs its answers, as the real gateway does.
function serve(state: Fake, auth: { basic: string } | { token: string }) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if ("basic" in auth) return answer(state, request, auth.basic)
      const url = new URL(request.url)
      const nonce = verifyRequest({
        token: auth.token,
        method: request.method,
        target: url.pathname + url.search,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
        now: Date.now(),
      })
      if (!nonce) return new Response("unauthorized", { status: 401 })
      state.peerHeaders.push(Object.fromEntries(request.headers.entries()))
      const response = await answer(state, request, undefined)
      const body = new Uint8Array(await response.arrayBuffer())
      const signature = signResponse(auth.token, nonce, body)
      // An on-path attacker rewriting the body after it was signed.
      const sent = state.tamper
        ? new TextEncoder().encode(new TextDecoder().decode(body).replace("ses_", "ses_x"))
        : body
      return new Response(sent, { status: response.status, headers: { [SYNC_RESPONSE_SIGNATURE_HEADER]: signature } })
    },
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

async function answer(state: Fake, request: Request, basic: string | undefined): Promise<Response> {
  if (state.down) return new Response("down", { status: 503 })
  if (basic !== undefined && request.headers.get("authorization") !== basic)
    return new Response("unauthorized", { status: 401 })
  if (state.paused) return Response.json({ error: "paused" }, { status: 503 })
  const path = new URL(request.url).pathname
  if (/^\/flynncode-sync\/(delete|archive)\//.test(path)) {
    state.writes.push({ path, body: (await request.json()) as Record<string, unknown> })
    return Response.json({ ok: true })
  }
  if (path === "/flynncode-sync/manifest") {
    state.manifestHits += 1
    await state.gate
    return Response.json(state.manifest)
  }
  if (path === "/flynncode-sync/missing") return Response.json({ directories: ["/gone"] })
  if (path === "/flynncode-sync/reload" && request.method === "GET")
    return Response.json({ pending: state.reloadPending })
  if (path === "/flynncode-sync/reload") {
    state.reloadPending = null
    return Response.json({ ok: true })
  }
  if (path === "/flynncode-sync/settings") return Response.json(state.settings)
  if (path === "/flynncode-sync/prefs") return Response.json({ prefs: state.prefs })
  if (path === "/flynncode-sync/settings/apply") {
    const body = (await request.json()) as { from?: string }
    state.settingsApplied.push(body)
    if (body.from) state.reloadPending = { from: body.from }
    return Response.json({ applied: true, changed: true })
  }
  if (path === "/flynncode-sync/apply") {
    const body = (await request.json()) as {
      bundle: { session: { id: string; time_updated: number } }
      expected: unknown
    }
    const id = body.bundle.session.id
    state.writes.push({ path, body })
    if (state.busyApply.has(id)) return Response.json({ error: "busy" }, { status: 409 })
    if (state.staleApply.has(id)) return Response.json({ error: "stale" }, { status: 409 })
    if (state.failApply.has(id)) return new Response("apply failed", { status: 422 })
    state.applied.push(id)
    state.manifest.sessions.push(session(id, body.bundle.session.time_updated))
    return Response.json({ ok: true })
  }
  const bundle = /^\/flynncode-sync\/session\/(.+)$/.exec(path)
  if (bundle?.[1]) state.bundleHits += 1
  if (bundle?.[1]) state.bundleLog.push(bundle[1])
  if (bundle?.[1]) state.onBundle?.()
  const failing = bundle?.[1] ? state.bundleStatuses.get(bundle[1]) : undefined
  if (failing) return new Response("bundle", { status: failing })
  if (bundle?.[1] && state.bundleStatus) return new Response("bundle", { status: state.bundleStatus })
  if (bundle?.[1]) return Response.json(state.bundles.get(bundle[1]))
  return new Response("not found", { status: 404 })
}

function worker(input: {
  local: Fake
  peer: Fake
  token?: string
  prefs?: { current?: SyncPrefs; applied: SyncPrefs[] }
  timing?: { pollMs: number; backoffMs: number; batchDelayMs: number }
  onStatus?: (status: SyncStatus) => void
}) {
  const localUrl = serve(input.local, { basic: "Basic local" })
  const peerUrl = serve(input.peer, { token: PEER_TOKEN })
  const prefs = input.prefs ?? { applied: [] }
  return createSyncWorker({
    local: { url: localUrl, authorization: "Basic local" },
    peer: () => ({ name: "starship", url: peerUrl, token: input.token ?? PEER_TOKEN }),
    paused: () => false,
    prefs: { get: () => prefs.current, apply: (next) => prefs.applied.push(next) },
    takeSent: () => 3,
    onStatus: input.onStatus ?? (() => undefined),
    ...input.timing,
  })
}

describe("sync worker", () => {
  test("pulls newer chats and reports the cycle", async () => {
    const local = fake([session("ses_a", 10)])
    const peer = fake([session("ses_a", 20), session("ses_b", 5)])
    const status = await worker({ local, peer }).cycle()
    expect(local.applied).toEqual(["ses_a", "ses_b"])
    expect(status).toMatchObject({
      phase: "idle",
      online: true,
      received: 2,
      sent: 3,
      missingDirectories: ["/gone"],
      backlog: null,
      failures: [],
      consecutiveFailures: 0,
    })
    expect(status.lastSuccess).toBeNumber()
  })

  test("pauses on a schema or app version mismatch without applying", async () => {
    const local = fake([], "s1")
    const peer = fake([session("ses_a", 20)], "s2")
    const status = await worker({ local, peer }).cycle()
    expect(status.phase).toBe("mismatch")
    expect(local.applied).toEqual([])
  })

  test("asks to pair again on 401", async () => {
    const status = await worker({ local: fake([]), peer: fake([]), token: "stale" }).cycle()
    expect(status.phase).toBe("unauthorized")
  })

  test("counts consecutive offline cycles and backs off after five", async () => {
    const peer = fake([])
    peer.down = true
    const sync = worker({ local: fake([]), peer })
    const results = []
    for (const _ of [1, 2, 3, 4, 5]) results.push(await sync.cycle())
    expect(results.map((status) => status.consecutiveFailures)).toEqual([1, 2, 3, 4, 5])
    expect(results.every((status) => status.phase === "offline" && !status.online)).toBe(true)
    expect(nextDelay(results[3]!)).toBe(60_000)
    expect(nextDelay(results[4]!)).toBe(300_000)
    peer.down = false
    const recovered = await sync.cycle()
    expect(recovered.consecutiveFailures).toBe(0)
    expect(nextDelay(recovered)).toBe(60_000)
  })

  test("pulls at most 20 bundles per cycle and reports first-sync progress", async () => {
    const local = fake([])
    const peer = fake(Array.from({ length: 25 }, (_, index) => session(`ses_${String(index).padStart(2, "0")}`, 10)))
    const sync = worker({ local, peer })
    const first = await sync.cycle()
    expect(local.applied.length).toBe(20)
    expect(first.backlog).toEqual({ done: 20, total: 25 })
    expect(nextDelay(first)).toBe(1_000)
    const second = await sync.cycle()
    expect(local.applied.length).toBe(25)
    expect(second.backlog).toBeNull()
  })

  test("forwards peer settings to the local server and applies newer peer prefs", async () => {
    const local = fake([])
    const peer = fake([])
    local.settings = { config: { theme: "dark" }, mtime: 4 }
    peer.settings = { config: { model: "a/b" }, mtime: 9 }
    peer.prefs = { sections: { appearance: { fontSize: 16 } }, updatedAt: 20 }
    const prefs = { current: { sections: {}, updatedAt: 10 }, applied: [] as SyncPrefs[] }
    await worker({ local, peer, prefs }).cycle()
    expect(local.settingsApplied).toEqual([{ config: { model: "a/b" }, mtime: 9, from: "starship" }])
    expect(prefs.applied).toEqual([peer.prefs])
  })

  test("treats a null config on either side as nothing to sync", async () => {
    const unreadableLocal = fake([])
    const peerWithConfig = fake([])
    peerWithConfig.settings = { config: { model: "a/b" }, mtime: 9 }
    await worker({ local: unreadableLocal, peer: peerWithConfig }).cycle()
    expect(unreadableLocal.settingsApplied).toEqual([])

    const readableLocal = fake([])
    readableLocal.settings = { config: { theme: "dark" }, mtime: 4 }
    const emptyPeer = fake([])
    const status = await worker({ local: readableLocal, peer: emptyPeer }).cycle()
    expect(readableLocal.settingsApplied).toEqual([])
    expect(status.lastError).toBeNull()
  })

  test("fills a fresh machine with no global config from the peer", async () => {
    const local = fake([])
    local.settings = { config: null, mtime: 0, missing: true }
    const peer = fake([])
    peer.settings = { config: { model: "a/b" }, mtime: 9 }
    await worker({ local, peer }).cycle()
    expect(local.settingsApplied).toEqual([{ config: { model: "a/b" }, mtime: 9, from: "starship" }])
  })

  test("does not let chats that keep failing starve the rest of a backlog", async () => {
    const stuck = Array.from({ length: 25 }, (_, index) => `ses_bad${String(index).padStart(2, "0")}`)
    const local = fake([])
    const peer = fake([...stuck.map((id) => session(id, 10)), session("ses_zgood", 10)])
    local.failApply = new Set(stuck)
    const sync = worker({ local, peer })
    // Nothing is known to fail yet, so the first batch is the first 20 in order.
    const first = await sync.cycle()
    expect(first.failures.length).toBe(20)
    expect(local.applied).toEqual([])
    // The failed 20 now go last, so the good chat is pulled in the next cycle.
    const second = await sync.cycle()
    expect(local.applied).toEqual(["ses_zgood"])
    // The five never-tried failures come before the 14 retried ones that fit in the batch.
    expect(second.failures.length).toBe(19)
    expect(second.failures.map((item) => item.id)).toEqual(expect.arrayContaining(stuck.slice(20)))
  })

  test("only uses the batch delay while a cycle is still making progress", async () => {
    const stuck = Array.from({ length: 25 }, (_, index) => `ses_${String(index).padStart(2, "0")}`)
    const local = fake([])
    local.failApply = new Set(stuck)
    const status = await worker({ local, peer: fake(stuck.map((id) => session(id, 10))) }).cycle()
    expect(status.backlog).toEqual({ done: 0, total: 25 })
    expect(status.received).toBe(0)
    expect(nextDelay(status)).toBe(60_000)
  })

  test("a backlog does not defeat backoff when the peer goes offline", async () => {
    const timing = { pollMs: 25, backoffMs: 200, batchDelayMs: 1 }
    const peer = fake(Array.from({ length: 25 }, (_, index) => session(`ses_${String(index).padStart(2, "0")}`, 10)))
    const seen: Array<{ status: SyncStatus; at: number }> = []
    const finished = Promise.withResolvers<void>()
    const sync = worker({
      local: fake([]),
      peer,
      timing,
      onStatus: (status) => {
        seen.push({ status, at: performance.now() })
        // The first cycle leaves a backlog; the peer then drops off the network.
        if (status.backlog) peer.down = true
        if (status.consecutiveFailures >= 5) {
          const offline = seen.filter((item) => item.status.phase === "offline")
          if (offline.length >= 6) finished.resolve()
        }
      },
    })
    sync.start()
    // A stuck loop fails through the test timeout instead of leaving a timer behind.
    await finished.promise
    sync.stop()
    const offline = seen.filter((item) => item.status.phase === "offline")
    expect(offline.length).toBeGreaterThanOrEqual(6)
    expect(offline.every((item) => item.status.backlog === null)).toBe(true)
    // Failed cycles poll at the normal interval, not the 1 ms batch delay...
    expect(offline[1]!.at - offline[0]!.at).toBeGreaterThanOrEqual(timing.pollMs - 5)
    // ...and the sixth-in-a-row waits for the backoff.
    expect(offline[5]!.at - offline[4]!.at).toBeGreaterThanOrEqual(timing.backoffMs - 5)
    expect(nextDelay(offline[5]!.status, timing)).toBe(timing.backoffMs)
  })

  test("applies a parent before its child even when the parent is stuck", async () => {
    const local = fake([])
    const others = Array.from({ length: 21 }, (_, index) => session(`ses_o${String(index).padStart(2, "0")}`, 10))
    // The child is listed first, so only parents-first ordering puts the parent ahead.
    const peer = fake([session("ses_child", 10, "ses_parent"), session("ses_parent", 10), ...others])
    local.busyApply = new Set(["ses_parent"])
    const sync = worker({ local, peer })
    await sync.cycle()
    await sync.cycle()
    expect(local.applied).not.toContain("ses_child")
    expect(local.applied.length).toBe(21)
    local.busyApply.clear()
    await sync.cycle()
    expect(local.applied.slice(-2)).toEqual(["ses_parent", "ses_child"])
  })

  test("ends the cycle at the first unreachable or unauthorized bundle fetch", async () => {
    const peer = fake([session("ses_a", 10), session("ses_b", 10), session("ses_c", 10)])
    peer.bundleStatus = 503
    const sync = worker({ local: fake([]), peer })
    const offline = await sync.cycle()
    expect(offline).toMatchObject({ phase: "offline", online: false, consecutiveFailures: 1, backlog: null })
    expect(peer.bundleHits).toBe(1)
    peer.bundleStatus = 401
    expect((await sync.cycle()).phase).toBe("unauthorized")
    expect(peer.bundleHits).toBe(2)
  })

  test("reports a local server outage as offline without a backlog", async () => {
    const local = fake([])
    local.down = true
    const status = await worker({ local, peer: fake([session("ses_a", 10)]) }).cycle()
    expect(status).toMatchObject({
      phase: "offline",
      online: false,
      backlog: null,
      lastError: "local server unavailable",
    })
  })

  test("syncNow joins a running cycle instead of overlapping it", async () => {
    const peer = fake([])
    const release = Promise.withResolvers<void>()
    peer.gate = release.promise
    const sync = worker({ local: fake([]), peer })
    const first = sync.cycle()
    const joined = [sync.syncNow(), sync.syncNow()]
    await Bun.sleep(50)
    expect(peer.manifestHits).toBe(1)
    release.resolve()
    await Promise.all([first, ...joined])
    // One follow-up cycle serves every overlapping syncNow.
    expect(peer.manifestHits).toBe(2)
  })

  test("stop cancels the timer and forgets stuck chats", async () => {
    const timing = { pollMs: 20, backoffMs: 20, batchDelayMs: 20 }
    const peer = fake([])
    const idle = Promise.withResolvers<void>()
    const sync = worker({ local: fake([]), peer, timing, onStatus: () => idle.resolve() })
    sync.start()
    await idle.promise
    sync.stop()
    const hits = peer.manifestHits
    await Bun.sleep(100)
    expect(peer.manifestHits).toBe(hits)

    const stuck = Array.from({ length: 25 }, (_, index) => `ses_bad${String(index).padStart(2, "0")}`)
    const local = fake([])
    local.failApply = new Set(stuck)
    const again = worker({ local, peer: fake([...stuck.map((id) => session(id, 10)), session("ses_zgood", 10)]) })
    await again.cycle()
    again.stop()
    await again.cycle()
    // Without the stuck memory the same 20 failing chats fill the batch again.
    expect(local.applied).toEqual([])
  })

  test("a bad bundle response fails only that chat and demotes it", async () => {
    const ids = Array.from({ length: 45 }, (_, index) => `ses_${String(index).padStart(2, "0")}`)
    const local = fake([])
    const peer = fake(ids.map((id) => session(id, 10)))
    peer.bundleStatuses = new Map([
      ["ses_00", 404],
      ["ses_01", 500],
    ])
    const sync = worker({ local, peer })
    const first = await sync.cycle()
    expect(first).toMatchObject({ phase: "idle", online: true, consecutiveFailures: 0, received: 18 })
    expect(first.failures.map((item) => item.id)).toEqual(["ses_00", "ses_01"])
    expect(first.failures.map((item) => item.error)).toEqual(["fetch failed (HTTP 404)", "fetch failed (HTTP 500)"])
    expect(local.applied.length).toBe(18)
    // The two failing chats go behind the 25 untried ones, so they are not retried yet.
    const second = await sync.cycle()
    expect(second.failures).toEqual([])
    expect(peer.bundleLog.filter((id) => id === "ses_00" || id === "ses_01").length).toBe(2)
    expect(local.applied.length).toBe(38)
  })

  test("defers a child whose parent is unresolved as a visible skip", async () => {
    const local = fake([])
    local.busyApply = new Set(["ses_parent"])
    const peer = fake([session("ses_parent", 10), session("ses_child", 10, "ses_parent")])
    const status = await worker({ local, peer }).cycle()
    expect(status.skipped).toEqual([
      { id: "ses_parent", reason: "local-busy" },
      { id: "ses_child", reason: "local-busy" },
    ])
    expect(status.failures).toEqual([])
  })

  test("a local outage during the batch ends the cycle as a local outage", async () => {
    const local = fake([])
    const peer = fake([session("ses_a", 10), session("ses_b", 10)])
    // The local server drops as soon as the first bundle has been served.
    peer.onBundle = () => {
      local.down = true
    }
    const status = await worker({ local, peer }).cycle()
    expect(status).toMatchObject({
      phase: "offline",
      online: false,
      backlog: null,
      lastError: "local server unavailable",
    })
    expect(peer.bundleLog).toEqual(["ses_a"])
  })

  test("skips a chat the peer started running after its manifest and retries it next cycle", async () => {
    const local = fake([])
    const peer = fake([session("ses_a", 10), session("ses_b", 10)])
    peer.bundleStatuses = new Map([["ses_a", 409]])
    const sync = worker({ local, peer })
    const first = await sync.cycle()
    expect(first).toMatchObject({ phase: "idle", failures: [], skipped: [{ id: "ses_a", reason: "peer-busy" }] })
    expect(local.applied).toEqual(["ses_b"])
    peer.bundleStatuses.clear()
    const second = await sync.cycle()
    expect(second.skipped).toEqual([])
    expect(local.applied).toEqual(["ses_b", "ses_a"])
  })

  test("sends what it saw of each local chat as a precondition and skips a chat that changed", async () => {
    const local = fake([session("ses_old", 10), session("ses_gone", 10), session("ses_shelf", 10)])
    const peer = fake([
      session("ses_old", 20),
      session("ses_new", 5),
      { ...session("ses_shelf", 10), timeArchived: 30 },
    ])
    peer.manifest.tombstones = [{ id: "ses_gone", timeDeleted: 50 }]
    local.staleApply = new Set(["ses_old"])
    const status = await worker({ local, peer }).cycle()
    const sent = local.writes
      .filter((write) => write.path !== "/flynncode-sync/apply")
      .map((write) => [write.path, write.body.expected])
    expect(sent).toEqual([
      ["/flynncode-sync/delete/ses_gone", { timeUpdated: 10, timeArchived: null }],
      ["/flynncode-sync/archive/ses_shelf", { timeUpdated: 10, timeArchived: null }],
    ])
    expect(
      local.writes.filter((write) => write.path === "/flynncode-sync/apply").map((write) => write.body.expected),
    ).toEqual([{ timeUpdated: 10, timeArchived: null }, null])
    // A chat that changed here waits for the next manifest instead of failing.
    expect(status.failures).toEqual([])
    expect(status.skipped).toEqual([{ id: "ses_old", reason: "local-changed" }])
    expect(local.applied).toEqual(["ses_new"])
  })

  test("shows a paused peer as reachable and keeps polling at the normal interval", async () => {
    const peer = fake([session("ses_a", 10)])
    peer.paused = true
    const local = fake([])
    const sync = worker({ local, peer })
    const results = []
    for (const _ of [1, 2, 3, 4, 5, 6]) results.push(await sync.cycle())
    expect(results.every((status) => status.phase === "peer-paused" && status.online)).toBe(true)
    expect(results.at(-1)?.consecutiveFailures).toBe(0)
    expect(nextDelay(results.at(-1)!)).toBe(60_000)
    expect(local.applied).toEqual([])
    peer.paused = false
    expect((await sync.cycle()).phase).toBe("idle")
    expect(local.applied).toEqual(["ses_a"])
  })

  test("signs every peer request without ever sending the token", async () => {
    const local = fake([])
    const peer = fake([session("ses_a", 10)])
    peer.settings = { config: { model: "a/b" }, mtime: 9 }
    peer.prefs = { sections: {}, updatedAt: 1 }
    await worker({ local, peer }).cycle()
    // manifest, bundle, settings and prefs
    expect(peer.peerHeaders.length).toBe(4)
    expect(peer.peerHeaders.every((headers) => headers["x-flynncode-sync-signature"] !== undefined)).toBe(true)
    expect(JSON.stringify(peer.peerHeaders)).not.toContain(PEER_TOKEN)
    expect(local.applied).toEqual(["ses_a"])
  })

  test("never uses a peer reply whose body was altered after signing", async () => {
    const local = fake([])
    const peer = fake([session("ses_a", 10)])
    peer.tamper = true
    peer.settings = { config: { model: "ses_evil" }, mtime: 9 }
    const status = await worker({ local, peer }).cycle()
    expect(status).toMatchObject({ phase: "offline", lastError: "the other computer's reply failed verification" })
    expect(local.applied).toEqual([])
    expect(local.settingsApplied).toEqual([])
  })

  test("reports a pulled config waiting for a reload and clears it on reloadConfig", async () => {
    const local = fake([])
    const peer = fake([])
    local.settings = { config: { theme: "dark" }, mtime: 4 }
    peer.settings = { config: { model: "a/b" }, mtime: 9 }
    const statuses: SyncStatus[] = []
    const sync = worker({ local, peer, onStatus: (status) => statuses.push(status) })
    expect((await sync.cycle()).configReloadPending).toEqual({ from: "starship" })
    const reloaded = await sync.reloadConfig()
    expect(reloaded.configReloadPending).toBeNull()
    expect(local.reloadPending).toBeNull()
    expect(statuses.at(-1)?.configReloadPending).toBeNull()
  })

  test("reports unpaired when there is no peer", async () => {
    const sync = createSyncWorker({
      local: { url: "http://127.0.0.1:9", authorization: "Basic local" },
      peer: () => undefined,
      paused: () => false,
      prefs: { get: () => undefined, apply: () => undefined },
      takeSent: () => 0,
      onStatus: () => undefined,
    })
    expect((await sync.cycle()).phase).toBe("unpaired")
    expect(initialStatus().phase).toBe("unpaired")
  })
})
