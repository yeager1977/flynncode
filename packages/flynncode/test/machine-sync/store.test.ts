import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@flynncode/core/database/database"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { EventSequenceTable } from "@flynncode/core/event/sql"
import { ModelV2 } from "@flynncode/core/model"
import { ProjectV2 } from "@flynncode/core/project"
import { ProjectTable } from "@flynncode/core/project/sql"
import { ProviderV2 } from "@flynncode/core/provider"
import { AbsolutePath } from "@flynncode/core/schema"
import { SessionExecution } from "@flynncode/core/session/execution"
import { SessionMessage } from "@flynncode/core/session/message"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  SessionTombstoneTable,
} from "@flynncode/core/session/sql"
import { tmpdir } from "node:os"
import { GlobalBus } from "@/bus/global"
import { MachineSyncStore } from "@/machine-sync/store"
import { Project } from "@/project/project"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// Stands in for the V2 engine: a session is "running" while its id is in this set.
const executing = new Set<SessionID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(executing)),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([MachineSyncStore.node, Database.node]), [[SessionExecution.node, execution]]),
)
// A folder that never exists keeps the apply path off Project.fromDirectory.
const directory = "/nonexistent/flynncode-machine-sync"
const DAY = 24 * 60 * 60 * 1000

// The row's JSON column types a union through Omit, which keeps only the keys
// shared by every member. Declaring the full shape first sidesteps the
// excess-property check without a cast.
const userMessage = {
  role: "user" as const,
  time: { created: 1 },
  agent: "build",
  model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
}
const textPart = (text: string) => ({ type: "text" as const, text })

const seed = Effect.fn("test.machineSync.seed")(function* (id: string, time_updated = 10) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: SessionID.make(id),
      project_id: ProjectV2.ID.global,
      slug: id,
      directory,
      title: id,
      version: "test",
      time_created: 1,
      time_updated,
    })
    .run()
  yield* db
    .insert(MessageTable)
    .values({
      id: MessageID.make(`msg_${id}`),
      session_id: SessionID.make(id),
      time_created: 1,
      time_updated: 1,
      data: userMessage,
    })
    .run()
  yield* db
    .insert(PartTable)
    .values({
      id: PartID.make(`prt_${id}`),
      message_id: MessageID.make(`msg_${id}`),
      session_id: SessionID.make(id),
      time_created: 1,
      time_updated: 1,
      data: textPart(`hello ${id}`),
    })
    .run()
})

const version = (timeUpdated: number, timeArchived: number | null = null) => ({ timeUpdated, timeArchived })

// The version the sync worker would send for a chat, read from the manifest.
const versionIn = Effect.fn("test.machineSync.versionIn")(function* (id: string) {
  const store = yield* MachineSyncStore.Service
  const entry = (yield* store.manifest()).sessions.find((session) => session.id === id)
  return entry ? version(entry.timeUpdated, entry.timeArchived) : null
})

const status = (sessionID: string, type: "busy" | "idle") =>
  GlobalBus.emit("event", { payload: { type: "session.status", properties: { sessionID, status: { type } } } })

describe("MachineSyncStore", () => {
  it.effect("lists active and archived sessions and prunes tombstones older than 30 days", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_active", 20)
      yield* seed("ses_archived", 30)
      yield* db
        .update(SessionTable)
        .set({ time_archived: 40, time_updated: 30 })
        .where(eq(SessionTable.id, SessionID.make("ses_archived")))
        .run()
      yield* db
        .insert(SessionTombstoneTable)
        .values([
          { id: SessionID.make("ses_recent"), time_deleted: Date.now() - DAY },
          { id: SessionID.make("ses_old"), time_deleted: Date.now() - 31 * DAY },
        ])
        .run()

      const manifest = yield* store.manifest()

      expect(manifest.sessions.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "ses_active", parentID: null, timeUpdated: 20, timeArchived: null, busy: false },
        { id: "ses_archived", parentID: null, timeUpdated: 30, timeArchived: 40, busy: false },
      ])
      expect(manifest.tombstones.map((tombstone) => tombstone.id)).toEqual(["ses_recent"])
      expect(
        yield* db
          .select()
          .from(SessionTombstoneTable)
          .where(eq(SessionTombstoneTable.id, SessionID.make("ses_old")))
          .get(),
      ).toBeUndefined()
      expect(manifest.schema).not.toBe("none")
    }),
  )

  it.effect("marks sessions busy from session.status events", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_busy")
      status("ses_busy", "busy")
      expect((yield* store.manifest()).sessions[0]?.busy).toBe(true)
      status("ses_busy", "idle")
      expect((yield* store.manifest()).sessions[0]?.busy).toBe(false)
    }),
  )

  it.effect("marks sessions busy while the V2 engine is executing them", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_v2busy")
      executing.add(SessionID.make("ses_v2busy"))
      expect((yield* store.manifest()).sessions[0]?.busy).toBe(true)
      expect(
        (yield* store
          .remove({ sessionID: SessionID.make("ses_v2busy"), timeDeleted: 1, expected: version(10) })
          .pipe(Effect.flip))._tag,
      ).toBe("MachineSyncBusyError")
      executing.delete(SessionID.make("ses_v2busy"))
      expect((yield* store.manifest()).sessions[0]?.busy).toBe(false)
    }),
  )

  it.effect("exports a bundle without owner claims and applies a newer copy over the local chat", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_trip")
      yield* db.insert(EventSequenceTable).values({ aggregate_id: "ses_trip", seq: 3, owner_id: "owner-1" }).run()

      const exported = yield* store.bundle(SessionID.make("ses_trip"))
      if (!exported) return yield* Effect.die(new Error("seeded session missing"))
      expect(exported.eventSequence).toEqual({ aggregate_id: "ses_trip", seq: 3, owner_id: null })
      expect(exported.parts.map((part) => part.id)).toEqual([PartID.make("prt_ses_trip")])

      yield* db
        .update(SessionTable)
        .set({ title: "changed locally" })
        .where(eq(SessionTable.id, SessionID.make("ses_trip")))
        .run()
      yield* store.apply({
        bundle: { ...exported, session: { ...exported.session, title: "from peer", time_updated: 99 } },
        expected: yield* versionIn("ses_trip"),
      })

      const after = yield* store.bundle(SessionID.make("ses_trip"))
      expect(after?.session.title).toBe("from peer")
      expect(after?.session.time_updated).toBe(99)
      expect(after?.messages.map((message) => message.id)).toEqual([MessageID.make("msg_ses_trip")])
      expect(after?.parts.map((part) => part.data)).toEqual([textPart("hello ses_trip")])
    }),
  )

  it.effect("leaves the local chat byte-identical when an apply fails", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_safe")
      const before = yield* store.bundle(SessionID.make("ses_safe"))
      if (!before) return yield* Effect.die(new Error("seeded session missing"))
      const part = before.parts[0]
      if (!part) return yield* Effect.die(new Error("seeded part missing"))

      const failure = yield* store
        .apply({
          bundle: {
            ...before,
            session: { ...before.session, title: "must not land", time_updated: 500 },
            // The part points at a message that is not in the bundle, so the
            // foreign key fails after the local rows were already deleted.
            parts: [{ ...part, id: PartID.make("prt_orphan"), message_id: MessageID.make("msg_missing") }],
          },
          expected: version(10),
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("MachineSyncApplyError")
      expect(JSON.stringify(yield* store.bundle(SessionID.make("ses_safe")))).toBe(JSON.stringify(before))
    }),
  )

  it.effect("refuses to apply over or delete a running chat", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_running")
      const exported = yield* store.bundle(SessionID.make("ses_running"))
      if (!exported) return yield* Effect.die(new Error("seeded session missing"))
      status("ses_running", "busy")
      expect((yield* store.apply({ bundle: exported, expected: version(10) }).pipe(Effect.flip))._tag).toBe(
        "MachineSyncBusyError",
      )
      expect(
        (yield* store
          .remove({ sessionID: SessionID.make("ses_running"), timeDeleted: 1, expected: version(10) })
          .pipe(Effect.flip))._tag,
      ).toBe("MachineSyncBusyError")
      // A peer never copies a chat mid-turn.
      expect((yield* store.bundle(SessionID.make("ses_running")).pipe(Effect.flip))._tag).toBe("MachineSyncBusyError")
      status("ses_running", "idle")
      expect((yield* store.bundle(SessionID.make("ses_running")))?.session.id).toBe(SessionID.make("ses_running"))
    }),
  )

  it.effect("deletes with the peer's deletion time and archives without moving time_updated", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_gone")
      yield* seed("ses_shelved", 77)

      yield* store.remove({ sessionID: SessionID.make("ses_gone"), timeDeleted: 1234, expected: version(10) })
      yield* store.archive({ sessionID: SessionID.make("ses_shelved"), timeArchived: 5678, expected: version(77) })

      expect(yield* store.bundle(SessionID.make("ses_gone"))).toBeUndefined()
      expect(
        yield* db
          .select()
          .from(SessionTombstoneTable)
          .where(eq(SessionTombstoneTable.id, SessionID.make("ses_gone")))
          .get(),
      ).toEqual({ id: SessionID.make("ses_gone"), time_deleted: 1234 })
      const shelved = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make("ses_shelved")))
        .get()
      expect({ archived: shelved?.time_archived, updated: shelved?.time_updated }).toEqual({
        archived: 5678,
        updated: 77,
      })
    }),
  )

  it.effect("reports active chat folders that do not exist on this machine", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_missing")
      expect(yield* store.missingDirectories()).toEqual([directory])
    }),
  )

  it.live("versions a chat by its newest content, not only the session row", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_turn", 10)
      expect(yield* versionIn("ses_turn")).toEqual(version(10))

      // The legacy engine writes a reply's parts without touching the session
      // row; the insert and the later upsert both stamp time_updated.
      const started = Date.now()
      yield* db
        .insert(PartTable)
        .values({
          id: PartID.make("prt_reply"),
          message_id: MessageID.make("msg_ses_turn"),
          session_id: SessionID.make("ses_turn"),
          time_created: 2,
          data: textPart("reply"),
        })
        .run()
      const afterInsert = (yield* versionIn("ses_turn"))?.timeUpdated ?? 0
      expect(afterInsert).toBeGreaterThanOrEqual(started)
      yield* Effect.sleep("5 millis")
      yield* db
        .insert(PartTable)
        .values({
          id: PartID.make("prt_reply"),
          message_id: MessageID.make("msg_ses_turn"),
          session_id: SessionID.make("ses_turn"),
          time_created: 2,
          data: textPart("reply, finished"),
        })
        .onConflictDoUpdate({ target: PartTable.id, set: { data: textPart("reply, finished") } })
        .run()
      const afterUpsert = (yield* versionIn("ses_turn"))?.timeUpdated ?? 0
      expect(afterUpsert).toBeGreaterThan(afterInsert)
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make("ses_turn")))
        .get()
      expect(row?.time_updated).toBe(10)

      // A copy applied elsewhere keeps the row stamps, so it carries the same
      // version and the tie rule keeps both sides still.
      const exported = yield* store.bundle(SessionID.make("ses_turn"))
      if (!exported) return yield* Effect.die(new Error("seeded session missing"))
      yield* store.remove({ sessionID: SessionID.make("ses_turn"), timeDeleted: 1, expected: version(afterUpsert) })
      yield* store.apply({ bundle: exported, expected: null })
      expect(yield* versionIn("ses_turn")).toEqual(version(afterUpsert))
    }),
  )

  it.effect("versions a V2 chat by its inputs and projected messages", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* seed("ses_v2turn", 10)
      yield* db
        .insert(SessionInputTable)
        .values({
          id: SessionMessage.ID.make("msg_v2input"),
          session_id: SessionID.make("ses_v2turn"),
          prompt: { text: "hello" },
          delivery: "steer",
          admitted_seq: 1,
          time_created: 40,
        })
        .run()
      expect(yield* versionIn("ses_v2turn")).toEqual(version(40))
      // The row stores the encoded message without its id and type columns.
      const {
        id: _,
        type,
        ...data
      } = encodeMessage(
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_v2reply"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
          content: [],
          time: { created: DateTime.makeUnsafe(41) },
        }),
      )
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make("msg_v2reply"),
          session_id: SessionID.make("ses_v2turn"),
          type,
          seq: 1,
          time_created: 41,
          time_updated: 60,
          data,
        })
        .run()
      expect(yield* versionIn("ses_v2turn")).toEqual(version(60))
    }),
  )

  it.effect("refuses writes to a chat that changed since the worker read the manifest", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_moved", 10)
      const exported = yield* store.bundle(SessionID.make("ses_moved"))
      if (!exported) return yield* Effect.die(new Error("seeded session missing"))
      const peer = { ...exported, session: { ...exported.session, title: "from peer", time_updated: 50 } }

      expect((yield* store.apply({ bundle: peer, expected: version(9) }).pipe(Effect.flip))._tag).toBe(
        "MachineSyncStaleError",
      )
      // "absent" no longer holds once the chat exists here.
      expect((yield* store.apply({ bundle: peer, expected: null }).pipe(Effect.flip))._tag).toBe(
        "MachineSyncStaleError",
      )
      expect((yield* store.apply({ bundle: peer, expected: version(10, 5) }).pipe(Effect.flip))._tag).toBe(
        "MachineSyncStaleError",
      )
      expect(
        (yield* store
          .remove({ sessionID: SessionID.make("ses_moved"), timeDeleted: 99, expected: version(9) })
          .pipe(Effect.flip))._tag,
      ).toBe("MachineSyncStaleError")
      expect(
        (yield* store
          .archive({ sessionID: SessionID.make("ses_moved"), timeArchived: 99, expected: version(9) })
          .pipe(Effect.flip))._tag,
      ).toBe("MachineSyncStaleError")
      expect(JSON.stringify(yield* store.bundle(SessionID.make("ses_moved")))).toBe(JSON.stringify(exported))

      yield* store.apply({ bundle: peer, expected: version(10) })
      expect((yield* store.bundle(SessionID.make("ses_moved")))?.session.title).toBe("from peer")
    }),
  )

  it.effect("tells open views about the messages and parts an apply changed", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_open", 10)
      const exported = yield* store.bundle(SessionID.make("ses_open"))
      const kept = exported?.parts[0]
      const message = exported?.messages[0]
      if (!exported || !kept || !message) return yield* Effect.die(new Error("seeded session missing"))
      const seen: Array<{ type: string; properties: Record<string, unknown> }> = []
      const listen = (event: { payload: { type: string; properties: Record<string, unknown> } }) => {
        if (event.payload.properties.sessionID === "ses_open") seen.push(event.payload)
      }
      GlobalBus.on("event", listen)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listen)))

      yield* store.apply({
        bundle: {
          ...exported,
          session: { ...exported.session, time_updated: 20 },
          parts: [{ ...kept, id: PartID.make("prt_new"), time_updated: 20, data: textPart("from peer") }],
        },
        expected: version(10),
      })

      expect(seen.map((event) => event.type)).toEqual([
        "session.updated",
        "message.part.removed",
        "message.part.updated",
        "todo.updated",
      ])
      expect(seen[1]?.properties).toMatchObject({ messageID: message.id, partID: kept.id })
      expect(seen[2]?.properties.part).toMatchObject({ id: "prt_new", sessionID: "ses_open", text: "from peer" })
    }),
  )

  it.effect("rejects malformed bundles", () =>
    Effect.sync(() => {
      expect(MachineSyncStore.isBundle({})).toBe(false)
      expect(MachineSyncStore.isBundle({ version: 1, session: { id: "not-a-session" } })).toBe(false)
    }),
  )
})

// Stands in for a project lookup that crashes, e.g. on an unreadable folder.
const unreachable = () => Effect.die(new Error("project lookup exploded"))
const brokenProject = Layer.succeed(
  Project.Service,
  Project.Service.of({
    init: unreachable,
    fromDirectory: unreachable,
    discover: unreachable,
    list: unreachable,
    get: unreachable,
    update: unreachable,
    initGit: unreachable,
    setInitialized: unreachable,
    sandboxes: unreachable,
    addSandbox: unreachable,
    removeSandbox: unreachable,
  }),
)
const itBroken = testEffect(
  AppNodeBuilder.build(LayerNode.group([MachineSyncStore.node, Database.node]), [
    [SessionExecution.node, execution],
    [Project.node, brokenProject],
  ]),
)

describe("MachineSyncStore with a failing project lookup", () => {
  itBroken.effect("reports the failure as an apply error and keeps the local chat", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_lookup", 10)
      const before = yield* store.bundle(SessionID.make("ses_lookup"))
      if (!before) return yield* Effect.die(new Error("seeded session missing"))
      // An existing folder sends the apply through the project lookup.
      const failure = yield* store
        .apply({
          bundle: { ...before, session: { ...before.session, directory: tmpdir(), time_updated: 50 } },
          expected: version(10),
        })
        .pipe(Effect.flip)
      expect(failure._tag).toBe("MachineSyncApplyError")
      expect(failure._tag === "MachineSyncApplyError" ? failure.message : "").toContain("project lookup exploded")
      expect(JSON.stringify(yield* store.bundle(SessionID.make("ses_lookup")))).toBe(JSON.stringify(before))
    }),
  )
})
