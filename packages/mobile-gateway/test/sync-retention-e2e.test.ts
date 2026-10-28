import { describe, expect, test } from "bun:test"
import type { Manifest, ManifestSession, Tombstone } from "../src/sync-decide.ts"
import { SYNC_NONCE_HEADER, SYNC_RESPONSE_SIGNATURE_HEADER, signResponse } from "../src/sync-sign.ts"
import { createSyncWorker } from "../src/sync-worker.ts"

// A laptop and a desktop synced through a hub, each store mirroring the server's sync routes (MachineSyncStore):
// - an apply replaces the chat and drops its tombstone; when the chat belongs to a retention deletion here and that
//   deletion never judged it, or its tree here is now newer than the basis or kept, every tombstone of the deletion goes;
// - a delete removes the chat and records the sender's tombstone, root included; a retention delete is refused while
//   the tree here is newer than its basis or kept;
// - a tree delete removes a retention deletion's members here in one step, judged the same way;
// - a void drops every tombstone of a retention deletion.
// The real sync worker (and so the real decide, voids and decidePush) runs every cycle.

const TOKEN = "00".repeat(32)
const L = 1_000_000
const DAY = 24 * 60 * 60 * 1000
const ROOT = "ses_root"
const CHILD = "ses_child"

type Store = {
  sessions: Map<string, ManifestSession>
  tombstones: Map<string, Tombstone>
  /** Every chat a delete removed here after the scenario was set up. */
  deleted: string[]
  /** Chats whose apply fails here, as a bundle the server cannot store would. */
  refuse: Set<string>
}

function store(sessions: ManifestSession[]): Store {
  return {
    sessions: new Map(sessions.map((item) => [item.id, { ...item }])),
    tombstones: new Map(),
    deleted: [],
    refuse: new Set(),
  }
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
function retentionDelete(target: Store, root = ROOT) {
  const latest = Math.max(...[...target.sessions.values()].map((item) => item.timeUpdated))
  ;[...target.sessions.keys()].forEach((id) => {
    target.sessions.delete(id)
    target.tombstones.set(id, { id, timeDeleted: latest + 1, root })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// The tree holding these chats here (up to each top, then every descendant) is newer than `since` or kept.
function touched(target: Store, ids: string[], since: number) {
  const up = (id: string, seen: Set<string>): string[] => {
    const parentID = target.sessions.get(id)?.parentID
    if (!parentID || !target.sessions.has(parentID) || seen.has(parentID)) return [id]
    return [id, ...up(parentID, seen.add(id))]
  }
  const tops = new Set(ids.flatMap((id) => (target.sessions.has(id) ? up(id, new Set()) : [])))
  const members = [...target.sessions.values()].filter((item) => {
    const line = up(item.id, new Set())
    return line.some((id) => tops.has(id))
  })
  return members.some((item) => item.kept === true || item.timeUpdated >= since)
}

// The retention deletion a chat answers to here: its own tombstone's root, or the nearest deleted ancestor's.
function deletionOf(target: Store, incoming: ManifestSession) {
  const own = target.tombstones.get(incoming.id)?.root
  if (own !== undefined) return own
  const climb = (parentID: string | null, seen: Set<string>): string | undefined => {
    if (parentID === null || seen.has(parentID)) return undefined
    const root = target.tombstones.get(parentID)?.root
    if (root !== undefined) return root
    return climb(target.sessions.get(parentID)?.parentID ?? null, seen.add(parentID))
  }
  return climb(incoming.parentID, new Set())
}

function erase(target: Store, id: string, timeDeleted: number, root: string | undefined) {
  if (target.sessions.delete(id)) target.deleted.push(id)
  target.tombstones.set(id, { id, timeDeleted, ...(root === undefined ? {} : { root }) })
}

const stale = { status: 409, payload: { error: "stale" } }

function answer(target: Store, pathname: string, body: unknown): { status: number; payload: unknown } {
  if (pathname === "/flynncode-sync/manifest") return { status: 200, payload: manifest(target) }
  const read = /^\/flynncode-sync\/session\/(.+)$/.exec(pathname)
  if (read) {
    const found = target.sessions.get(decodeURIComponent(read[1] ?? ""))
    return found ? { status: 200, payload: { session: found } } : { status: 404, payload: { error: "not found" } }
  }
  if (pathname === "/flynncode-sync/apply" && isRecord(body) && isRecord(body.bundle)) {
    const incoming = body.bundle.session as ManifestSession
    if (target.refuse.has(incoming.id)) return { status: 422, payload: { error: "cannot store" } }
    const root = deletionOf(target, incoming)
    const members = [...target.tombstones.values()].filter((tombstone) => root !== undefined && tombstone.root === root)
    target.sessions.set(incoming.id, { ...incoming })
    target.tombstones.delete(incoming.id)
    const basis = Math.min(...members.map((tombstone) => tombstone.timeDeleted))
    if (
      root !== undefined &&
      members.length > 0 &&
      (!members.some((tombstone) => tombstone.id === incoming.id) || touched(target, [incoming.id], basis))
    )
      members.forEach((tombstone) => target.tombstones.delete(tombstone.id))
    return { status: 200, payload: { ok: true } }
  }
  const tree = /^\/flynncode-sync\/delete-tree\/(.+)$/.exec(pathname)
  if (tree && isRecord(body) && Array.isArray(body.members)) {
    const root = decodeURIComponent(tree[1] ?? "")
    const members = body.members as Array<{ id: string; timeDeleted: number }>
    const since = Math.min(...members.map((member) => member.timeDeleted))
    if (touched(target, [...members.map((member) => member.id), root], since)) return stale
    members.forEach((member) => erase(target, member.id, member.timeDeleted, root))
    return { status: 200, payload: { ok: true } }
  }
  const spare = /^\/flynncode-sync\/void\/(.+)$/.exec(pathname)
  if (spare) {
    const root = decodeURIComponent(spare[1] ?? "")
    ;[...target.tombstones.values()]
      .filter((tombstone) => tombstone.root === root)
      .forEach((tombstone) => target.tombstones.delete(tombstone.id))
    return { status: 200, payload: { ok: true } }
  }
  const remove = /^\/flynncode-sync\/delete\/(.+)$/.exec(pathname)
  if (remove && isRecord(body) && typeof body.timeDeleted === "number") {
    const id = decodeURIComponent(remove[1] ?? "")
    const root = typeof body.root === "string" ? body.root : undefined
    if (root !== undefined && touched(target, [id, root], body.timeDeleted)) return stale
    erase(target, id, body.timeDeleted, root)
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

// The hub and the laptop hold `shared`; the desktop holds its own copy. The laptop's retention deletes its tree.
function world(desktop: ManifestSession[], shared: ManifestSession[] = synced(), laptopOnly?: ManifestSession[]) {
  const hub = store(shared)
  const laptop = store(laptopOnly ?? shared)
  const peer = store(desktop)
  retentionDelete(laptop, shared[0]?.id)

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

// One round: the desktop syncs, then the laptop.
async function round(env: ReturnType<typeof world>) {
  expect((await env.desktopWorker.cycle()).phase).toBe("idle")
  expect((await env.laptopWorker.cycle()).phase).toBe("idle")
}

// Root R with 25 sub-agent sessions, more than one 20-chat batch.
const children = Array.from({ length: 25 }, (_, index) => `ses_c${String(index + 1).padStart(2, "0")}`)
const wide = (rootTime: number, lastChildTime = L - 2 * DAY) => [
  session(ROOT, rootTime),
  ...children.map((id, index) =>
    session(id, index === children.length - 1 ? lastChildTime : L - 2 * DAY, { parentID: ROOT }),
  ),
]
const everything = [ROOT, ...children].sort()

describe("a surviving tree larger than a batch converges without re-deletes", () => {
  test("the newer copy is the root, last in the desktop's table order", async () => {
    // The desktop re-applied R from sync last, so it sorts after its 25 children, then kept chatting in it.
    const [root, ...rest] = wide(L + 10 * DAY)
    const env = world([...rest, root!], wide(L))
    // The laptop's retention deleted the tree, and its cycle pushes the deletes to the hub first.
    expect((await env.laptopWorker.cycle()).phase).toBe("idle")
    expect(ids(env.hub)).toEqual([])
    const deletedAfterPush = env.laptop.deleted.length + env.hub.deleted.length

    // One round already brings the whole tree back: the evidence first, then the rest unbatched.
    await round(env)
    expect(ids(env.hub)).toEqual(everything)
    expect(ids(env.laptop)).toEqual(everything)
    await round(env)
    expect(ids(env.laptop)).toEqual(everything)
    expect(ids(env.hub)).toEqual(everything)
    expect(ids(env.desktop)).toEqual(everything)
    // Nothing was deleted again anywhere, and the desktop never lost a member.
    expect(env.desktop.deleted).toEqual([])
    expect(env.laptop.deleted.length + env.hub.deleted.length).toBe(deletedAfterPush)
    expect([...env.laptop.tombstones.values()]).toEqual([])
    expect([...env.hub.tombstones.values()]).toEqual([])
  })

  test("the newer copy is the 25th sub-agent session, behind the root and 23 others", async () => {
    const env = world(wide(L, L + 10 * DAY), wide(L))
    expect((await env.laptopWorker.cycle()).phase).toBe("idle")
    const deletedAfterPush = env.laptop.deleted.length + env.hub.deleted.length

    await round(env)
    await round(env)
    expect(ids(env.laptop)).toEqual(everything)
    expect(ids(env.hub)).toEqual(everything)
    expect(ids(env.desktop)).toEqual(everything)
    expect(env.desktop.deleted).toEqual([])
    expect(env.laptop.deleted.length + env.hub.deleted.length).toBe(deletedAfterPush)
  })
})

describe("a surviving tree whose evidence cannot reach the hub", () => {
  test("waits on the machine that has it, and nothing is deleted again meanwhile", async () => {
    const env = world(wide(L, L + 10 * DAY), wide(L))
    expect((await env.laptopWorker.cycle()).phase).toBe("idle")
    const deletedAfterPush = env.laptop.deleted.length + env.hub.deleted.length
    env.hub.refuse.add(children.at(-1)!)

    await round(env)
    await round(env)
    // The rest of the tree stays on the desktop instead of being pushed into the laptop's deletes again.
    expect(ids(env.hub)).toEqual([])
    expect(ids(env.desktop)).toEqual(everything)
    expect(env.laptop.deleted.length + env.hub.deleted.length).toBe(deletedAfterPush)

    env.hub.refuse.clear()
    await round(env)
    expect(ids(env.hub)).toEqual(everything)
    expect(ids(env.laptop)).toEqual(everything)
    expect(env.desktop.deleted).toEqual([])
    expect(env.laptop.deleted.length + env.hub.deleted.length).toBe(deletedAfterPush)
  })
})

describe("retention deletes with members missing on one side", () => {
  const GRANDCHILD = "ses_grandchild"
  const deep = (root: number, child: number, grandchild: number) => [
    session(ROOT, root),
    session(CHILD, child, { parentID: ROOT }),
    session(GRANDCHILD, grandchild, { parentID: CHILD }),
  ]

  test("a newer grandchild whose parent the desktop lacks keeps the root everywhere", async () => {
    // The desktop has R and G but never got C, and wrote in G since.
    const env = world([session(ROOT, L), session(GRANDCHILD, L + 10 * DAY, { parentID: CHILD })], deep(L, L, L))
    await settle(env)
    expect(env.desktop.deleted).toEqual([])
    expect(ids(env.desktop)).toEqual([GRANDCHILD, ROOT])
    expect(ids(env.hub)).toEqual([GRANDCHILD, ROOT])
    expect(ids(env.laptop)).toEqual([GRANDCHILD, ROOT])
  })

  test("a machine that lacks a member never deletes it from the others", async () => {
    // The laptop never got G; the hub and the desktop have it, untouched like the rest.
    const env = world(deep(L, L, L), deep(L, L, L), deep(L, L, L).slice(0, 2))
    await settle(env)
    expect(env.hub.deleted).toEqual([])
    expect(env.desktop.deleted).toEqual([])
    expect(ids(env.hub)).toEqual([CHILD, GRANDCHILD, ROOT])
    expect(ids(env.desktop)).toEqual([CHILD, GRANDCHILD, ROOT])
    // The laptop takes the whole tree back, the member it lacked included.
    expect(ids(env.laptop)).toEqual([CHILD, GRANDCHILD, ROOT])
    expect([...env.laptop.tombstones.values()]).toEqual([])
  })

  test("an archived member of a surviving tree goes back to the machine that deleted it", async () => {
    const env = world([session(ROOT, L + 10 * DAY), session(CHILD, L - 2 * DAY, { parentID: ROOT, timeArchived: L })])
    await settle(env)
    expect(ids(env.laptop)).toEqual([CHILD, ROOT])
    expect(ids(env.hub)).toEqual([CHILD, ROOT])
    expect(env.laptop.sessions.get(CHILD)?.timeArchived).toBe(L)
  })
})
