import { describe, expect, test } from "bun:test"
import { decide, decidePush, isManifest, voids, type Manifest, type ManifestSession } from "../src/sync-decide.ts"

const manifest = (sessions: ManifestSession[], tombstones: Manifest["tombstones"] = []): Manifest => ({
  schema: "20261008_session_tombstone",
  app: "1.18.34",
  sessions,
  tombstones,
})

const session = (id: string, timeUpdated: number, extra: Partial<ManifestSession> = {}): ManifestSession => ({
  id,
  parentID: null,
  timeUpdated,
  timeArchived: null,
  busy: false,
  ...extra,
})

describe("decide", () => {
  test("pulls chats that are newer on the peer or missing here, keeps equal and older ones", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10), session("ses_b", 10), session("ses_c", 30)]),
      peer: manifest([session("ses_a", 20), session("ses_b", 10), session("ses_c", 20), session("ses_d", 5)]),
    })
    expect(actions).toEqual([
      { type: "pull", id: "ses_a" },
      { type: "pull", id: "ses_d" },
    ])
  })

  test("skips a chat that is running here or on the peer", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10, { busy: true }), session("ses_b", 10)]),
      peer: manifest([session("ses_a", 20), session("ses_b", 20, { busy: true })]),
    })
    expect(actions).toEqual([
      { type: "skip", id: "ses_a", reason: "local-busy" },
      { type: "skip", id: "ses_b", reason: "peer-busy" },
    ])
  })

  test("deletes when the peer's tombstone is newer than the local copy", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10), session("ses_b", 50)]),
      peer: manifest(
        [],
        [
          { id: "ses_a", timeDeleted: 20 },
          { id: "ses_b", timeDeleted: 20 },
          { id: "ses_gone", timeDeleted: 20 },
        ],
      ),
    })
    expect(actions).toEqual([{ type: "delete", id: "ses_a", timeDeleted: 20 }])
  })

  test("does not pull back a chat deleted here after the peer's last change", () => {
    const actions = decide({
      local: manifest([], [{ id: "ses_a", timeDeleted: 30 }]),
      peer: manifest([session("ses_a", 20), session("ses_b", 40)]),
    })
    expect(actions).toEqual([{ type: "pull", id: "ses_b" }])
  })

  test("archives when the peer archived later, never pulls archived chats that are missing here", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10), session("ses_b", 50)]),
      peer: manifest([
        session("ses_a", 10, { timeArchived: 30 }),
        session("ses_b", 50, { timeArchived: 40 }),
        session("ses_c", 10, { timeArchived: 30 }),
      ]),
    })
    expect(actions).toEqual([{ type: "archive", id: "ses_a", timeArchived: 30 }])
  })

  test("pulls a chat archived here earlier than the peer's newer copy", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10, { timeArchived: 15 })]),
      peer: manifest([session("ses_a", 20)]),
    })
    expect(actions).toEqual([{ type: "pull", id: "ses_a" }])
  })

  test("applies parents before children", () => {
    const actions = decide({
      local: manifest([]),
      peer: manifest([
        session("ses_grandchild", 3, { parentID: "ses_child" }),
        session("ses_child", 2, { parentID: "ses_root" }),
        session("ses_root", 1),
      ]),
    })
    expect(actions.map((action) => action.id)).toEqual(["ses_root", "ses_child", "ses_grandchild"])
  })

  test("pulls instead of archiving when the peer worked on a chat and then archived it", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10)]),
      peer: manifest([session("ses_a", 20, { timeArchived: 30 })]),
    })
    expect(actions).toEqual([{ type: "pull", id: "ses_a" }])
  })

  test("pulls when both are archived and the peer content is newer, does nothing when it is not", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10, { timeArchived: 15 }), session("ses_b", 10, { timeArchived: 15 })]),
      peer: manifest([session("ses_a", 20, { timeArchived: 30 }), session("ses_b", 10, { timeArchived: 30 })]),
    })
    expect(actions).toEqual([{ type: "pull", id: "ses_a" }])
  })

  test("skips deletes and archives for a chat that is running here", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10, { busy: true }), session("ses_b", 10, { busy: true })]),
      peer: manifest([session("ses_b", 10, { timeArchived: 30 })], [{ id: "ses_a", timeDeleted: 20 }]),
    })
    expect(actions).toEqual([
      { type: "skip", id: "ses_a", reason: "local-busy" },
      { type: "skip", id: "ses_b", reason: "local-busy" },
    ])
  })

  test("skips a running peer chat that is missing here", () => {
    const actions = decide({
      local: manifest([]),
      peer: manifest([session("ses_a", 10, { busy: true })]),
    })
    expect(actions).toEqual([{ type: "skip", id: "ses_a", reason: "peer-busy" }])
  })

  test("equal timestamps keep the local copy", () => {
    const actions = decide({
      local: manifest([session("ses_a", 20), session("ses_b", 20)], [{ id: "ses_c", timeDeleted: 20 }]),
      peer: manifest(
        [session("ses_b", 20, { timeArchived: 20 }), session("ses_c", 20)],
        [{ id: "ses_a", timeDeleted: 20 }],
      ),
    })
    expect(actions).toEqual([])
  })

  test("a parent cycle terminates and pulls both chats", () => {
    const actions = decide({
      local: manifest([]),
      peer: manifest([session("ses_a", 1, { parentID: "ses_b" }), session("ses_b", 2, { parentID: "ses_a" })]),
    })
    expect(actions.map((action) => action.id).sort()).toEqual(["ses_a", "ses_b"])
  })

  test("pulls a child whose parent is not being pulled", () => {
    const actions = decide({
      local: manifest([session("ses_parent", 5)]),
      peer: manifest([session("ses_parent", 5), session("ses_child", 6, { parentID: "ses_parent" })]),
    })
    expect(actions).toEqual([{ type: "pull", id: "ses_child" }])
  })
})

const base = (sessions: Manifest["sessions"], tombstones: Manifest["tombstones"] = []): Manifest => ({
  schema: "s1",
  app: "a1",
  sessions,
  tombstones,
})

describe("decidePush", () => {
  test("pushes local-newer chat, ignores hub-newer and equal", () => {
    const local = base([{ id: "c1", parentID: null, timeUpdated: 200, timeArchived: null, busy: false }])
    const hub = base([{ id: "c1", parentID: null, timeUpdated: 100, timeArchived: null, busy: false }])
    expect(decidePush({ local, hub })).toEqual([{ type: "push", id: "c1" }])
  })
})

// Session retention stamps its tombstones with the newest activity it judged plus 1 ms, not the deletion time.
describe("retention tombstones", () => {
  const DAY = 24 * 60 * 60 * 1000
  const L = 1_000 * DAY
  // The laptop last synced on day L, then deleted S on day L + 31 as inactive since L.
  const laptop = manifest([], [{ id: "ses_s", timeDeleted: L + 1 }])

  test("a stale machine's delete neither pushes over nor deletes a copy worked on since", () => {
    // The desktop worked on S on day L + 10, and the hub has that copy.
    const hub = manifest([session("ses_s", L + 10 * DAY)])
    expect(decidePush({ local: laptop, hub })).toEqual([])
    expect(decide({ local: laptop, peer: hub })).toEqual([{ type: "pull", id: "ses_s" }])
    expect(decide({ local: hub, peer: laptop })).toEqual([])
  })

  test("still deletes a copy nobody touched since", () => {
    const hub = manifest([session("ses_s", L)])
    expect(decidePush({ local: laptop, hub })).toEqual([{ type: "delete", id: "ses_s", timeDeleted: L + 1 }])
    expect(decide({ local: hub, peer: laptop })).toEqual([{ type: "delete", id: "ses_s", timeDeleted: L + 1 }])
  })
})

describe("retention tombstones judged per tree", () => {
  const DAY = 24 * 60 * 60 * 1000
  const L = 1_000 * DAY
  // The laptop deleted tree R (root) + C (sub-agent) as inactive since day L: every member carries L + 1 and root R.
  const tombstones = [
    { id: "ses_r", timeDeleted: L + 1, root: "ses_r" },
    { id: "ses_c", timeDeleted: L + 1, root: "ses_r" },
  ]
  const laptop = manifest([], tombstones)
  const tree = (root: number, child: number, extra: Partial<ManifestSession> = {}) => [
    session("ses_r", root, extra),
    session("ses_c", child, { parentID: "ses_r" }),
  ]

  test("newer activity anywhere in the tree keeps every member on the peer and brings every member back", () => {
    for (const peer of [tree(L + 10 * DAY, L - 2 * DAY), tree(L, L + 10 * DAY), tree(L, L - 2 * DAY, { kept: true })]) {
      expect(decide({ local: manifest(peer), peer: laptop })).toEqual([])
      expect(decidePush({ local: laptop, hub: manifest(peer) })).toEqual([])
      expect(decide({ local: laptop, peer: manifest(peer) })).toEqual([
        { type: "pull", id: "ses_r" },
        { type: "pull", id: "ses_c" },
      ])
    }
  })

  test("a tree nobody touched is deleted whole, with its root on every action", () => {
    const peer = manifest(tree(L, L - 2 * DAY))
    const deletes = tombstones.map((tombstone) => ({ type: "delete" as const, ...tombstone }))
    expect(decide({ local: peer, peer: laptop })).toEqual(deletes)
    expect(decidePush({ local: laptop, hub: peer })).toEqual(deletes)
    expect(decide({ local: laptop, peer })).toEqual([])
  })

  test("a member is kept when its tree is newer on the side that still has the root", () => {
    // The hub already took the child's delete, but the desktop pushed its newer root first.
    const hub = manifest([session("ses_r", L + 10 * DAY)], [tombstones[1]!])
    const stale = manifest(tree(L, L - 2 * DAY))
    expect(decide({ local: stale, peer: hub })).toEqual([{ type: "pull", id: "ses_r" }])
  })

  test("a member of a tree running here waits instead of being deleted", () => {
    const peer = manifest([session("ses_r", L, { busy: true }), session("ses_c", L - 2 * DAY, { parentID: "ses_r" })])
    expect(decide({ local: peer, peer: laptop })).toEqual([
      { type: "skip", id: "ses_r", reason: "local-busy" },
      { type: "skip", id: "ses_c", reason: "local-busy" },
    ])
  })

  test("an archived member of a surviving tree comes back to the machine that deleted it", () => {
    const peer = manifest([
      session("ses_r", L + 10 * DAY),
      session("ses_c", L - 2 * DAY, { parentID: "ses_r", timeArchived: L }),
    ])
    expect(decide({ local: laptop, peer })).toEqual([
      { type: "pull", id: "ses_r" },
      { type: "pull", id: "ses_c" },
    ])
  })

  test("a manual delete stays per session: activity elsewhere in the tree does not undo it", () => {
    const manual = manifest([session("ses_r", L + 10 * DAY)], [{ id: "ses_c", timeDeleted: L + 1 }])
    const peer = manifest(tree(L + 10 * DAY, L - 2 * DAY))
    expect(decide({ local: peer, peer: manual })).toEqual([{ type: "delete", id: "ses_c", timeDeleted: L + 1 }])
    expect(decidePush({ local: manual, hub: peer })).toEqual([{ type: "delete", id: "ses_c", timeDeleted: L + 1 }])
  })
})

describe("surviving trees", () => {
  const DAY = 24 * 60 * 60 * 1000
  const L = 1_000 * DAY
  const deleted = (ids: string[], root = "ses_r") => ids.map((id) => ({ id, timeDeleted: L + 1, root }))

  test("the deleting machine voids every tombstone of a tree that survived, and never deletes it again", () => {
    const laptop = manifest([], deleted(["ses_r", "ses_c", "ses_g"]))
    // The hub has only the root back, newer: the whole deletion is void, not just the root's tombstone.
    const hub = manifest([session("ses_r", L + 10 * DAY)])
    expect(voids({ local: laptop, peer: hub })).toEqual(["ses_r"])
    expect(decidePush({ local: laptop, hub })).toEqual([])
    // A tree nobody touched is not voided.
    const untouched = manifest([
      session("ses_r", L),
      session("ses_c", L, { parentID: "ses_r" }),
      session("ses_g", L, { parentID: "ses_c" }),
    ])
    expect(voids({ local: laptop, peer: untouched })).toEqual([])
  })

  test("the evidence goes to the hub first and the rest of the tree after it, unbatched", () => {
    const desktop = manifest([
      session("ses_c", L, { parentID: "ses_r" }),
      session("ses_g", L + 10 * DAY, { parentID: "ses_c" }),
      session("ses_r", L),
    ])
    const hub = manifest([], deleted(["ses_r", "ses_c", "ses_g"]))
    expect(decidePush({ local: desktop, hub })).toEqual([
      { type: "push", id: "ses_g", tree: "ses_r", evidence: true },
      { type: "push", id: "ses_r", tree: "ses_r" },
      { type: "push", id: "ses_c", tree: "ses_r" },
    ])
    // Kept only by a job on this machine: nothing the deleter can see, so the tree stays here until its hold syncs.
    const scheduled = manifest([session("ses_r", L, { scheduled: true }), session("ses_c", L, { parentID: "ses_r" })])
    expect(decide({ local: scheduled, peer: hub })).toEqual([])
    expect(decidePush({ local: scheduled, hub })).toEqual([])
  })

  test("while the evidence is running, the members the hub lacks wait with it", () => {
    const desktop = manifest([
      session("ses_r", L + 10 * DAY, { busy: true }),
      session("ses_c", L, { parentID: "ses_r" }),
    ])
    const hub = manifest([], deleted(["ses_r", "ses_c"]))
    expect(decidePush({ local: desktop, hub })).toEqual([{ type: "skip", id: "ses_r", reason: "local-busy" }])
  })

  test("a side that lacks a member keeps the tree: an unknown member was never judged", () => {
    // The laptop never had G; the hub has the whole tree, untouched.
    const laptop = manifest([], deleted(["ses_r", "ses_c"]))
    const hub = manifest([
      session("ses_r", L),
      session("ses_c", L, { parentID: "ses_r" }),
      session("ses_g", L, { parentID: "ses_c" }),
    ])
    expect(decidePush({ local: laptop, hub })).toEqual([])
    expect(voids({ local: laptop, peer: hub })).toEqual(["ses_r"])
    expect(decide({ local: laptop, peer: hub }).map((action) => action.id)).toEqual(["ses_r", "ses_c", "ses_g"])
  })

  test("a newer grandchild whose parent this side lacks keeps its root", () => {
    const desktop = manifest([session("ses_r", L), session("ses_g", L + 10 * DAY, { parentID: "ses_c" })])
    const hub = manifest([], deleted(["ses_r", "ses_c", "ses_g"]))
    expect(decide({ local: desktop, peer: hub })).toEqual([])
    expect(decidePush({ local: desktop, hub }).map((action) => action.id)).toEqual(["ses_g", "ses_r"])
  })

  test("an archived chat travels with its tree, and stays local otherwise", () => {
    const here = manifest([session("ses_r", 10)])
    const peer = manifest([
      session("ses_r", 10),
      session("ses_c", 10, { parentID: "ses_r", timeArchived: 11 }),
      session("ses_x", 10, { timeArchived: 11 }),
    ])
    expect(decide({ local: here, peer })).toEqual([{ type: "pull", id: "ses_c" }])
    expect(decidePush({ local: peer, hub: here })).toEqual([{ type: "push", id: "ses_c" }])
  })
})

describe("isManifest", () => {
  test("accepts a manifest and rejects malformed input", () => {
    expect(isManifest(manifest([session("ses_a", 1)], [{ id: "ses_b", timeDeleted: 2 }]))).toBe(true)
    expect(isManifest({ schema: "x", app: "y", sessions: [{ id: "ses_a" }], tombstones: [] })).toBe(false)
    expect(isManifest(null)).toBe(false)
    expect(isManifest(manifest([], [{ id: "ses_b" } as never]))).toBe(false)
    expect(isManifest(manifest([], [{ id: "ses_b", timeDeleted: Number.NaN }]))).toBe(false)
    expect(isManifest(manifest([session("ses_a", Number.POSITIVE_INFINITY)]))).toBe(false)
    expect(
      isManifest(manifest([session("ses_a", 1, { kept: true })], [{ id: "ses_b", timeDeleted: 2, root: "ses_a" }])),
    ).toBe(true)
    expect(isManifest(manifest([], [{ id: "ses_b", timeDeleted: 2, root: 3 } as never]))).toBe(false)
    expect(isManifest(manifest([session("ses_a", 1, { kept: "yes" } as never)]))).toBe(false)
  })
})
