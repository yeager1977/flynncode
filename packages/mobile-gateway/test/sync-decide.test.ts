import { describe, expect, test } from "bun:test"
import { decide, isManifest, type Manifest, type ManifestSession } from "../src/sync-decide.ts"

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
})

describe("isManifest", () => {
  test("accepts a manifest and rejects malformed input", () => {
    expect(isManifest(manifest([session("ses_a", 1)], [{ id: "ses_b", timeDeleted: 2 }]))).toBe(true)
    expect(isManifest({ schema: "x", app: "y", sessions: [{ id: "ses_a" }], tombstones: [] })).toBe(false)
    expect(isManifest(null)).toBe(false)
  })
})
