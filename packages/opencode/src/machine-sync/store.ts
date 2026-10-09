export * as MachineSyncStore from "./store"

import { asc, eq, isNull, lt } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import {
  MessageTable,
  PartTable,
  SessionContextEpochTable,
  SessionFolderTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  SessionTombstoneTable,
  TodoTable,
} from "@opencode-ai/core/session/sql"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
// Large chats are inserted in chunks to stay far below SQLite's bound
// parameter limit.
const INSERT_CHUNK = 200
// Both machines must run the same database schema; the newest migration id
// names it.
const SCHEMA_VERSION =
  migrations
    .map((migration) => migration.id)
    .sort()
    .at(-1) ?? "none"

export type ManifestSession = {
  id: string
  parentID: string | null
  timeUpdated: number
  timeArchived: number | null
  busy: boolean
}

export type Manifest = {
  schema: string
  app: string
  sessions: ManifestSession[]
  tombstones: Array<{ id: string; timeDeleted: number }>
}

type SessionRow = typeof SessionTable.$inferSelect

export type Bundle = {
  version: 1
  session: SessionRow
  project: typeof ProjectTable.$inferSelect | null
  messages: Array<typeof MessageTable.$inferSelect>
  parts: Array<typeof PartTable.$inferSelect>
  todos: Array<typeof TodoTable.$inferSelect>
  folders: Array<typeof SessionFolderTable.$inferSelect>
  inputs: Array<typeof SessionInputTable.$inferSelect>
  sessionMessages: Array<typeof SessionMessageTable.$inferSelect>
  contextEpoch: typeof SessionContextEpochTable.$inferSelect | null
  eventSequence: typeof EventSequenceTable.$inferSelect | null
  events: Array<typeof EventTable.$inferSelect>
}

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("MachineSyncBusyError", {
  sessionID: Schema.String,
}) {}

export class ApplyError extends Schema.TaggedErrorClass<ApplyError>()("MachineSyncApplyError", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  /** Every session (archived ones carry `timeArchived`) plus tombstones from the last 30 days. */
  readonly manifest: () => Effect.Effect<Manifest>
  /** Everything that defines one chat; owner claims are cleared. */
  readonly bundle: (sessionID: SessionID) => Effect.Effect<Bundle | undefined>
  /** Replaces the local chat with the bundle in one transaction. */
  readonly apply: (bundle: Bundle) => Effect.Effect<void, BusyError | ApplyError>
  readonly remove: (input: { sessionID: SessionID; timeDeleted: number }) => Effect.Effect<void, BusyError>
  readonly archive: (input: { sessionID: SessionID; timeArchived: number }) => Effect.Effect<void, BusyError>
  /** Distinct folders of unarchived chats that do not exist on this machine. */
  readonly missingDirectories: () => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MachineSyncStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fs = yield* FSUtil.Service
    const project = yield* Project.Service
    const execution = yield* SessionExecution.Service

    // Session status is instance-scoped, but every status change crosses the
    // process-wide GlobalBus, so the set covers chats in every directory.
    const busy = new Set<string>()
    const track = (event: GlobalEvent) => {
      const payload: unknown = event.payload
      if (!isRecord(payload) || !isRecord(payload.properties)) return
      const sessionID = payload.properties.sessionID
      if (typeof sessionID !== "string") return
      if (payload.type === "session.idle") {
        busy.delete(sessionID)
        return
      }
      if (payload.type !== "session.status" || !isRecord(payload.properties.status)) return
      if (payload.properties.status.type === "idle") busy.delete(sessionID)
      if (payload.properties.status.type !== "idle") busy.add(sessionID)
    }
    GlobalBus.on("event", track)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", track)))

    // A chat is running when either engine says so: the legacy runner's status
    // events or the V2 engine's active set.
    const running = Effect.fn("MachineSyncStore.running")(function* () {
      return new Set([...busy, ...(yield* execution.active)])
    })

    const manifest = Effect.fn("MachineSyncStore.manifest")(function* () {
      yield* db
        .delete(SessionTombstoneTable)
        .where(lt(SessionTombstoneTable.time_deleted, Date.now() - TOMBSTONE_TTL_MS))
        .run()
        .pipe(Effect.orDie)
      const sessions = yield* db
        .select({
          id: SessionTable.id,
          parent_id: SessionTable.parent_id,
          time_updated: SessionTable.time_updated,
          time_archived: SessionTable.time_archived,
        })
        .from(SessionTable)
        .all()
        .pipe(Effect.orDie)
      const tombstones = yield* db.select().from(SessionTombstoneTable).all().pipe(Effect.orDie)
      const active = yield* running()
      // A session re-created under the same id (an import, a pulled chat)
      // outranks its old tombstone.
      const live = new Set(sessions.map((row) => row.id))
      return {
        schema: SCHEMA_VERSION,
        app: InstallationVersion,
        sessions: sessions.map((row) => ({
          id: row.id,
          parentID: row.parent_id ?? null,
          timeUpdated: row.time_updated,
          timeArchived: row.time_archived ?? null,
          busy: active.has(row.id),
        })),
        tombstones: tombstones
          .filter((row) => !live.has(row.id))
          .map((row) => ({ id: row.id, timeDeleted: row.time_deleted })),
      } satisfies Manifest
    })

    const bundle = Effect.fn("MachineSyncStore.bundle")(function* (sessionID: SessionID) {
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return undefined
      const projectRow = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, session.project_id))
        .get()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const contextEpoch = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return {
        version: 1,
        session,
        project: projectRow ?? null,
        messages: yield* db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.session_id, sessionID))
          .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
          .all()
          .pipe(Effect.orDie),
        parts: yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.session_id, sessionID))
          .orderBy(asc(PartTable.id))
          .all()
          .pipe(Effect.orDie),
        todos: yield* db
          .select()
          .from(TodoTable)
          .where(eq(TodoTable.session_id, sessionID))
          .orderBy(asc(TodoTable.position))
          .all()
          .pipe(Effect.orDie),
        folders: yield* db
          .select()
          .from(SessionFolderTable)
          .where(eq(SessionFolderTable.session_id, sessionID))
          .orderBy(asc(SessionFolderTable.position))
          .all()
          .pipe(Effect.orDie),
        inputs: yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID))
          .orderBy(asc(SessionInputTable.admitted_seq))
          .all()
          .pipe(Effect.orDie),
        sessionMessages: yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie),
        contextEpoch: contextEpoch ?? null,
        // Owner claims are process-local, so they never leave this machine.
        eventSequence: sequence ? { ...sequence, owner_id: null } : null,
        events: yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie),
      } satisfies Bundle
    })

    const apply = Effect.fn("MachineSyncStore.apply")(function* (input: Bundle) {
      const sessionID = input.session.id
      if ((yield* running()).has(sessionID)) return yield* new BusyError({ sessionID })
      // A chat whose folder is missing here is still stored and readable; it
      // keeps the peer's project row so the foreign key holds.
      const present = yield* fs.existsSafe(input.session.directory)
      const projectID = present
        ? (yield* project.fromDirectory(input.session.directory)).project.id
        : input.session.project_id
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (!present && input.project)
              yield* tx.insert(ProjectTable).values(input.project).onConflictDoNothing().run()
            yield* tx.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()
            yield* tx.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
            yield* tx.delete(SessionTombstoneTable).where(eq(SessionTombstoneTable.id, sessionID)).run()
            yield* tx
              .insert(SessionTable)
              .values({ ...input.session, project_id: projectID })
              .run()
            yield* Effect.forEach(chunks(input.messages), (rows) => tx.insert(MessageTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(chunks(input.parts), (rows) => tx.insert(PartTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(chunks(input.todos), (rows) => tx.insert(TodoTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(chunks(input.folders), (rows) => tx.insert(SessionFolderTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(chunks(input.inputs), (rows) => tx.insert(SessionInputTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(
              chunks(input.sessionMessages),
              (rows) => tx.insert(SessionMessageTable).values(rows).run(),
              { discard: true },
            )
            if (input.contextEpoch) yield* tx.insert(SessionContextEpochTable).values(input.contextEpoch).run()
            if (input.eventSequence)
              yield* tx
                .insert(EventSequenceTable)
                .values({ ...input.eventSequence, owner_id: null })
                .run()
            yield* Effect.forEach(chunks(input.events), (rows) => tx.insert(EventTable).values(rows).run(), {
              discard: true,
            })
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new ApplyError({ sessionID, message: cause instanceof Error ? cause.message : String(cause) }),
          ),
        )
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (row) emit("session.updated", row)
    })

    const remove = Effect.fn("MachineSyncStore.remove")(function* (input: {
      sessionID: SessionID
      timeDeleted: number
    }) {
      if ((yield* running()).has(input.sessionID)) return yield* new BusyError({ sessionID: input.sessionID })
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, input.sessionID)).run()
            yield* tx.delete(SessionTable).where(eq(SessionTable.id, input.sessionID)).run()
            yield* tx
              .insert(SessionTombstoneTable)
              .values({ id: input.sessionID, time_deleted: input.timeDeleted })
              .onConflictDoUpdate({ target: SessionTombstoneTable.id, set: { time_deleted: input.timeDeleted } })
              .run()
          }),
        )
        .pipe(Effect.orDie)
      if (row) emit("session.deleted", row)
    })

    const archive = Effect.fn("MachineSyncStore.archive")(function* (input: {
      sessionID: SessionID
      timeArchived: number
    }) {
      if ((yield* running()).has(input.sessionID)) return yield* new BusyError({ sessionID: input.sessionID })
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      // time_updated has an $onUpdate default; pin it so archiving here does
      // not look like a newer local edit to the peer.
      yield* db
        .update(SessionTable)
        .set({ time_archived: input.timeArchived, time_updated: row.time_updated })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      emit("session.updated", { ...row, time_archived: input.timeArchived })
    })

    const missingDirectories = Effect.fn("MachineSyncStore.missingDirectories")(function* () {
      const rows = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(isNull(SessionTable.time_archived))
        .all()
        .pipe(Effect.orDie)
      const directories = [...new Set(rows.map((row) => row.directory))]
      const missing = yield* Effect.forEach(
        directories,
        (directory) => fs.existsSafe(directory).pipe(Effect.map((exists) => (exists ? undefined : directory))),
        { concurrency: 8 },
      )
      return missing.filter((directory): directory is string => directory !== undefined).sort()
    })

    return Service.of({ manifest, bundle, apply, remove, archive, missingDirectories })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, FSUtil.node, Project.node, SessionExecution.node],
})

export function isBundle(input: unknown): input is Bundle {
  if (!isRecord(input) || input.version !== 1 || !isRecord(input.session)) return false
  const session = input.session
  if (typeof session.id !== "string" || !session.id.startsWith("ses")) return false
  if (typeof session.project_id !== "string" || typeof session.directory !== "string") return false
  if (typeof session.time_updated !== "number") return false
  const owned = [input.messages, input.parts, input.todos, input.folders, input.inputs, input.sessionMessages]
  if (
    !owned.every((rows) => Array.isArray(rows) && rows.every((row) => isRecord(row) && row.session_id === session.id))
  )
    return false
  if (!Array.isArray(input.events) || !input.events.every((row) => isRecord(row) && row.aggregate_id === session.id))
    return false
  if (
    input.eventSequence !== null &&
    !(isRecord(input.eventSequence) && input.eventSequence.aggregate_id === session.id)
  )
    return false
  if (input.contextEpoch !== null && !(isRecord(input.contextEpoch) && input.contextEpoch.session_id === session.id))
    return false
  return input.project === null || (isRecord(input.project) && input.project.id === session.project_id)
}

function chunks<T>(rows: readonly T[]) {
  return Array.from({ length: Math.ceil(rows.length / INSERT_CHUNK) }, (_, index) =>
    rows.slice(index * INSERT_CHUNK, (index + 1) * INSERT_CHUNK),
  )
}

// Sync writes bypass the event log, so the UI hears about them through the
// same GlobalBus channel the SSE stream already forwards.
function emit(type: "session.updated" | "session.deleted", row: SessionRow) {
  GlobalBus.emit("event", {
    directory: row.directory,
    project: row.project_id,
    payload: { type, properties: { sessionID: row.id, info: Session.fromRow(row) } },
  })
}
