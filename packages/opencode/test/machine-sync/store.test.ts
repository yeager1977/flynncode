import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { MessageTable, PartTable, SessionTable, SessionTombstoneTable } from "@opencode-ai/core/session/sql"
import { GlobalBus } from "@/bus/global"
import { MachineSyncStore } from "@/machine-sync/store"
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
        (yield* store.remove({ sessionID: SessionID.make("ses_v2busy"), timeDeleted: 1 }).pipe(Effect.flip))._tag,
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
      yield* store.apply({ ...exported, session: { ...exported.session, title: "from peer", time_updated: 99 } })

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
          ...before,
          session: { ...before.session, title: "must not land", time_updated: 500 },
          // The part points at a message that is not in the bundle, so the
          // foreign key fails after the local rows were already deleted.
          parts: [{ ...part, id: PartID.make("prt_orphan"), message_id: MessageID.make("msg_missing") }],
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
      expect((yield* store.apply(exported).pipe(Effect.flip))._tag).toBe("MachineSyncBusyError")
      expect(
        (yield* store.remove({ sessionID: SessionID.make("ses_running"), timeDeleted: 1 }).pipe(Effect.flip))._tag,
      ).toBe("MachineSyncBusyError")
      status("ses_running", "idle")
    }),
  )

  it.effect("deletes with the peer's deletion time and archives without moving time_updated", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_gone")
      yield* seed("ses_shelved", 77)

      yield* store.remove({ sessionID: SessionID.make("ses_gone"), timeDeleted: 1234 })
      yield* store.archive({ sessionID: SessionID.make("ses_shelved"), timeArchived: 5678 })

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

  it.effect("rejects malformed bundles", () =>
    Effect.sync(() => {
      expect(MachineSyncStore.isBundle({})).toBe(false)
      expect(MachineSyncStore.isBundle({ version: 1, session: { id: "not-a-session" } })).toBe(false)
    }),
  )
})
