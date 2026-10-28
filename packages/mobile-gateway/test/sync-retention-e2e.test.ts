import { describe, expect, test } from "bun:test"
import type { Manifest, ManifestSession, Tombstone } from "../src/sync-decide.ts"
import { SYNC_NONCE_HEADER, SYNC_RESPONSE_SIGNATURE_HEADER, signResponse } from "../src/sync-sign.ts"
import { createSyncWorker } from "../src/sync-worker.ts"

// A laptop and a desktop synced through a hub, each store mirroring the server's sync routes: an apply replaces the
// chat and drops its tombstone, a delete removes the chat and records the sender's tombstone, root included. The
// real sync worker (and so the real decide and decidePush) runs every cycle.

const TOKEN = "00".repeat(32)
const L = 1_000_000
const DAY = 24 * 60 * 60 * 1000
const ROOT = "ses_root"
const CHILD = "ses_child"

type Store = { sessions: Map<string, ManifestSession>; tombstones: Map<string, Tombstone> }

function store(sessions: ManifestSession[]): Store {
  return { sessions: new Map(sessions.map((item) => [item.id, { ...item }])), tombstones: new Map() }
}

const session = (id: string, timeUpdated: number, extra: Partial<ManifestSession> = {}): ManifestSession => ({
  id,
  parentID: null,
  timeUpdated,
  timeArchived: null,
  busy: false,
  kept: false,
  ...extra,
})

// Root R and its sub-agent session C, last written on day L everywhere; C's own last write is two days older.
const synced = () => [session(ROOT, L), session(CHILD, L - 2 * DAY, { parentID: ROOT })]

function manifest(target: Store): Manifest {
  return {
    schema: "s1",
    app: "a1",
    sessions: [...target.sessions.values()],
    tombstones: [...target.tombstones.values()].filter((tombstone) => !target.sessions.has(tombstone.id)),
  }
}

// What the laptop's retention pass does: every member's tombstone carries the tree's activity plus 1 ms and its root.
function retentionDelete(target: Store) {
  const latest = Math.max(...[...target.sessions.values()].map((item) => item.timeUpdated))
  ;[...target.sessions.keys()].forEach((id) => {
    target.sessions.delete(id)
    target.tombstones.set(id, { id, timeDeleted: latest + 1, root: ROOT })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function answer(target: Store, pathname: string, body: unknown): { status: number; payload: unknown } {
  if (pathname === "/flynncode-sync/manifest") return { status: 200, payload: manifest(target) }
  const read = /^\/flynncode-sync\/session\/(.+)$/.exec(pathname)
  if (read) {
    const found = target.sessions.get(decodeURIComponent(read[1] ?? ""))
    return found ? { status: 200, payload: { session: found } } : { status: 404, payload: { error: "not found" } }
  }
  if (pathname === "/flynncode-sync/apply" && isRecord(body) && isRecord(body.bundle)) {
    const incoming = body.bundle.session as ManifestSession
    target.sessions.set(incoming.id, { ...incoming })
    target.tombstones.delete(incoming.id)
    return { status: 200, payload: { ok: true } }
  }
  const remove = /^\/flynncode-sync\/delete\/(.+)$/.exec(pathname)
  if (remove && isRecord(body) && typeof body.timeDeleted === "number") {
    const id = decodeURIComponent(remove[1] ?? "")
    target.sessions.delete(id)
    target.tombstones.set(id, {
      id,
      timeDeleted: body.timeDeleted,
      ...(typeof body.root === "string" ? { root: body.root } : {}),
    })
    return { status: 200, payload: { ok: true } }
  }
  if (pathname === "/flynncode-sync/missing") return { status: 200, payload: { directories: [] } }
  if (pathname === "/flynncode-sync/reload") return { status: 200, payload: { pending: null, busy: false } }
  if (pathname === "/flynncode-sync/settings") return { status: 200, payload: { config: null, mtime: 0 } }
  if (pathname === "/flynncode-sync/prefs") return { status: 200, payload: { prefs: null } }
  return { status: 404, payload: { error: "not found" } }
}

function nonceOf(init?: RequestInit) {
  const headers = init?.headers
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return null
  return headers[SYNC_NONCE_HEADER] ?? headers[SYNC_NONCE_HEADER.toLowerCase()] ?? null
}

function world(desktop: ManifestSession[]) {
  const hub = store(synced())
  const laptop = store(synced())
  const peer = store(desktop)
  retentionDelete(laptop)

  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    const pathname = new URL(target).pathname
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    if (target.startsWith("http://laptop/")) {
      const result = answer(laptop, pathname, body)
      return Response.json(result.payload, { status: result.status })
    }
    if (target.startsWith("http://desktop/")) {
      const result = answer(peer, pathname, body)
      return Response.json(result.payload, { status: result.status })
    }
    const result = answer(hub, pathname, body)
    const bytes = new TextEncoder().encode(JSON.stringify(result.payload))
    const nonce = nonceOf(init)
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (nonce) headers[SYNC_RESPONSE_SIGNATURE_HEADER] = signResponse(TOKEN, nonce, result.status, bytes)
    return new Response(bytes, { status: result.status, headers })
  }

  const worker = (local: string) =>
    createSyncWorker({
      local: { url: local, authorization: "Bearer x" },
      peer: () => ({ name: "hub", url: "http://hub", token: TOKEN }),
      paused: () => false,
      prefs: { get: () => undefined, apply: () => undefined },
      takeSent: () => 0,
      onStatus: () => undefined,
      fetchImpl: fetchImpl as typeof fetch,
    })

  return { hub, laptop, desktop: peer, laptopWorker: worker("http://laptop"), desktopWorker: worker("http://desktop") }
}

// The laptop syncs first, so its deletes reach the hub before the desktop's newer copy does: the hardest order.
async function settle(env: ReturnType<typeof world>) {
  for (const _ of [1, 2, 3]) {
    expect((await env.laptopWorker.cycle()).phase).toBe("idle")
    expect((await env.desktopWorker.cycle()).phase).toBe("idle")
  }
}

const ids = (target: Store) => [...target.sessions.keys()].sort()

describe("retention deletes across machines through the hub", () => {
  test("a tree the desktop touched only in its root keeps every member everywhere", async () => {
    const env = world([session(ROOT, L + 10 * DAY), session(CHILD, L - 2 * DAY, { parentID: ROOT })])
    await settle(env)
    expect(ids(env.laptop)).toEqual([CHILD, ROOT])
    expect(ids(env.hub)).toEqual([CHILD, ROOT])
    expect(ids(env.desktop)).toEqual([CHILD, ROOT])
    expect(env.laptop.sessions.get(CHILD)?.parentID).toBe(ROOT)
  })

  test("a tree with newer activity only in a sub-agent session keeps its root everywhere", async () => {
    const env = world([session(ROOT, L), session(CHILD, L + 10 * DAY, { parentID: ROOT })])
    await settle(env)
    expect(ids(env.laptop)).toEqual([CHILD, ROOT])
    expect(ids(env.hub)).toEqual([CHILD, ROOT])
    expect(ids(env.desktop)).toEqual([CHILD, ROOT])
  })

  test("a tree kept or held on the desktop, with nothing newer, keeps every member everywhere", async () => {
    const env = world([session(ROOT, L, { kept: true }), session(CHILD, L - 2 * DAY, { parentID: ROOT })])
    await settle(env)
    expect(ids(env.laptop)).toEqual([CHILD, ROOT])
    expect(ids(env.hub)).toEqual([CHILD, ROOT])
    expect(ids(env.desktop)).toEqual([CHILD, ROOT])
  })

  test("a tree nobody touched is still deleted everywhere", async () => {
    const env = world(synced())
    await settle(env)
    expect(ids(env.laptop)).toEqual([])
    expect(ids(env.hub)).toEqual([])
    expect(ids(env.desktop)).toEqual([])
    expect([...env.desktop.tombstones.values()]).toEqual([
      { id: ROOT, timeDeleted: L + 1, root: ROOT },
      { id: CHILD, timeDeleted: L + 1, root: ROOT },
    ])
  })
})
