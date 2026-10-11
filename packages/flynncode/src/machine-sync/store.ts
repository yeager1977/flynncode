export * as MachineSyncStore from "./store"

import { asc, eq, isNull, lt, max } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@flynncode/core/database/database"
import { migrations } from "@flynncode/core/database/migration.gen"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@flynncode/core/event/sql"
import { FSUtil } from "@flynncode/core/fs-util"
import { InstallationVersion } from "@flynncode/core/installation/version"
import { ProjectTable } from "@flynncode/core/project/sql"
import { SessionExecution } from "@flynncode/core/session/execution"
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
} from "@flynncode/core/session/sql"
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

/**
 * What the sync worker saw of a local chat when it decided to change it; null
 * means the chat did not exist. A write whose chat no longer matches is stale.
 */
export type Version = { timeUpdated: number; timeArchived: number | null }

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

export class StaleError extends Schema.TaggedErrorClass<StaleError>()("MachineSyncStaleError", {
  sessionID: Schema.String,
}) {}

export class ApplyError extends Schema.TaggedErrorClass<ApplyError>()("MachineSyncApplyError", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  /** Every session (archived ones carry `timeArchived`) plus tombstones from the last 30 days. */
  readonly manifest: () => Effect.Effect<Manifest>
  /** Everything that defines one chat, read in one transaction; owner claims are cleared. */
  readonly bundle: (sessionID: SessionID) => Effect.Effect<Bundle | undefined, BusyError>
  /** Replaces the local chat with the bundle in one transaction. */
  readonly apply: (input: {
    bundle: Bundle
    expected: Version | null
  }) => Effect.Effect<void, BusyError | StaleError | ApplyError>
  readonly remove: (input: {
    sessionID: SessionID
    timeDeleted: number
    expected: Version | null
  }) => Effect.Effect<void, BusyError | StaleError>
  readonly archive: (input: {
    sessionID: SessionID
    timeArchived: number
    expected: Version | null
  }) => Effect.Effect<void, BusyError | StaleError>
  /** Distinct folders of unarchived chats that do not exist on this machine. */
  readonly missingDirectories: () => Effect.Effect<string[]>
  /** True while no chat is running in either engine. */
  readonly idle: () => Effect.Effect<boolean>
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

    // A chat's version is its newest content write, not only the session row's
    // time_updated: the legacy engine touches the session when a prompt is
    // submitted, then writes the reply into message and part rows without
    // touching it again, and the V2 engine records inputs and projected
    // messages in their own rows. Every write to those rows stamps
    // time_updated (V2 inputs only have time_created), and an apply keeps the
    // peer's stamps, so both machines compute the same version for the same
    // content and the tie rule settles. The event log is not consulted: its
    // rows carry no time, and every V2 event that changes content also writes
    // one of these rows.
    const latest = Effect.fn("MachineSyncStore.latest")(function* (sessionID?: SessionID) {
      const groups = yield* Effect.all([
        db
          .select({ id: MessageTable.session_id, time: max(MessageTable.time_updated) })
          .from(MessageTable)
          .where(sessionID ? eq(MessageTable.session_id, sessionID) : undefined)
          .groupBy(MessageTable.session_id)
          .all(),
        db
          .select({ id: PartTable.session_id, time: max(PartTable.time_updated) })
          .from(PartTable)
          .where(sessionID ? eq(PartTable.session_id, sessionID) : undefined)
          .groupBy(PartTable.session_id)
          .all(),
        db
          .select({ id: TodoTable.session_id, time: max(TodoTable.time_updated) })
          .from(TodoTable)
          .where(sessionID ? eq(TodoTable.session_id, sessionID) : undefined)
          .groupBy(TodoTable.session_id)
          .all(),
        db
          .select({ id: SessionFolderTable.session_id, time: max(SessionFolderTable.time_updated) })
          .from(SessionFolderTable)
          .where(sessionID ? eq(SessionFolderTable.session_id, sessionID) : undefined)
          .groupBy(SessionFolderTable.session_id)
          .all(),
        db
          .select({ id: SessionMessageTable.session_id, time: max(SessionMessageTable.time_updated) })
          .from(SessionMessageTable)
          .where(sessionID ? eq(SessionMessageTable.session_id, sessionID) : undefined)
          .groupBy(SessionMessageTable.session_id)
          .all(),
        db
          .select({ id: SessionInputTable.session_id, time: max(SessionInputTable.time_created) })
          .from(SessionInputTable)
          .where(sessionID ? eq(SessionInputTable.session_id, sessionID) : undefined)
          .groupBy(SessionInputTable.session_id)
          .all(),
      ]).pipe(Effect.orDie)
      return groups
        .flat()
        .reduce(
          (times, row) => times.set(row.id, Math.max(times.get(row.id) ?? 0, row.time ?? 0)),
          new Map<string, number>(),
        )
    })

    // Only meaningful inside a transaction, where it matches what is written next.
    const current = Effect.fn("MachineSyncStore.current")(function* (sessionID: SessionID) {
      const row = yield* db
        .select({ time_updated: SessionTable.time_updated, time_archived: SessionTable.time_archived })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return null
      const times = yield* latest(sessionID)
      return {
        timeUpdated: Math.max(row.time_updated, times.get(sessionID) ?? 0),
        timeArchived: row.time_archived ?? null,
      } satisfies Version
    })

    // Runs first in every write transaction: a running chat or one that changed
    // since the worker read the manifest is left alone until the next cycle.
    const admit = Effect.fn("MachineSyncStore.admit")(function* (sessionID: SessionID, expected: Version | null) {
      if ((yield* running()).has(sessionID)) return yield* new BusyError({ sessionID })
      const now = yield* current(sessionID)
      if (!sameVersion(now, expected)) return yield* new StaleError({ sessionID })
    })

    const manifest = Effect.fn("MachineSyncStore.manifest")(function* () {
      yield* db
        .delete(SessionTombstoneTable)
        .where(lt(SessionTombstoneTable.time_deleted, Date.now() - TOMBSTONE_TTL_MS))
        .run()
        .pipe(Effect.orDie)
      const read = yield* db
        .transaction(() =>
          Effect.gen(function* () {
            return {
              sessions: yield* db
                .select({
                  id: SessionTable.id,
                  parent_id: SessionTable.parent_id,
                  time_updated: SessionTable.time_updated,
                  time_archived: SessionTable.time_archived,
                })
                .from(SessionTable)
                .all()
                .pipe(Effect.orDie),
              times: yield* latest(),
              tombstones: yield* db.select().from(SessionTombstoneTable).all().pipe(Effect.orDie),
            }
          }),
        )
        .pipe(Effect.orDie)
      const active = yield* running()
      // A session re-created under the same id (an import, a pulled chat)
      // outranks its old tombstone.
      const live = new Set(read.sessions.map((row) => row.id))
      return {
        schema: SCHEMA_VERSION,
        app: InstallationVersion,
        sessions: read.sessions.map((row) => ({
          id: row.id,
          parentID: row.parent_id ?? null,
          timeUpdated: Math.max(row.time_updated, read.times.get(row.id) ?? 0),
          timeArchived: row.time_archived ?? null,
          busy: active.has(row.id),
        })),
        tombstones: read.tombstones
          .filter((row) => !live.has(row.id))
          .map((row) => ({ id: row.id, timeDeleted: row.time_deleted })),
      } satisfies Manifest
    })

    const bundle = Effect.fn("MachineSyncStore.bundle")(function* (sessionID: SessionID) {
      // One read transaction, refused while the chat runs, so a peer never
      // copies a turn half written.
      return yield* db
        .transaction(() =>
          Effect.gen(function* () {
            if ((yield* running()).has(sessionID)) return yield* new BusyError({ sessionID })
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
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
    })

    const apply = Effect.fn("MachineSyncStore.apply")(function* (input: { bundle: Bundle; expected: Version | null }) {
      const incoming = input.bundle
      const sessionID = incoming.session.id
      // A chat whose folder is missing here is still stored and readable; it
      // keeps the peer's project row so the foreign key holds.
      const present = yield* fs.existsSafe(incoming.session.directory)
      const projectID = present
        ? (yield* project.fromDirectory(incoming.session.directory).pipe(
            Effect.catchDefect((defect) =>
              Effect.fail(
                new ApplyError({
                  sessionID,
                  message: `project lookup failed: ${defect instanceof Error ? defect.message : String(defect)}`,
                }),
              ),
            ),
          )).project.id
        : incoming.session.project_id
      const previous = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* admit(sessionID, input.expected)
            const shown = {
              messages: yield* tx
                .select({ id: MessageTable.id, time_updated: MessageTable.time_updated })
                .from(MessageTable)
                .where(eq(MessageTable.session_id, sessionID))
                .all(),
              parts: yield* tx
                .select({ id: PartTable.id, message_id: PartTable.message_id, time_updated: PartTable.time_updated })
                .from(PartTable)
                .where(eq(PartTable.session_id, sessionID))
                .all(),
            }
            if (!present && incoming.project)
              yield* tx.insert(ProjectTable).values(incoming.project).onConflictDoNothing().run()
            yield* tx.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()
            yield* tx.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
            yield* tx.delete(SessionTombstoneTable).where(eq(SessionTombstoneTable.id, sessionID)).run()
            yield* tx
              .insert(SessionTable)
              .values({ ...incoming.session, project_id: projectID })
              .run()
            yield* Effect.forEach(chunks(incoming.messages), (rows) => tx.insert(MessageTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(chunks(incoming.parts), (rows) => tx.insert(PartTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(chunks(incoming.todos), (rows) => tx.insert(TodoTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(
              chunks(incoming.folders),
              (rows) => tx.insert(SessionFolderTable).values(rows).run(),
              { discard: true },
            )
            yield* Effect.forEach(chunks(incoming.inputs), (rows) => tx.insert(SessionInputTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(
              chunks(incoming.sessionMessages),
              (rows) => tx.insert(SessionMessageTable).values(rows).run(),
              { discard: true },
            )
            if (incoming.contextEpoch) yield* tx.insert(SessionContextEpochTable).values(incoming.contextEpoch).run()
            if (incoming.eventSequence)
              yield* tx
                .insert(EventSequenceTable)
                .values({ ...incoming.eventSequence, owner_id: null })
                .run()
            yield* Effect.forEach(chunks(incoming.events), (rows) => tx.insert(EventTable).values(rows).run(), {
              discard: true,
            })
            return shown
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof BusyError || cause instanceof StaleError
              ? cause
              : new ApplyError({ sessionID, message: cause instanceof Error ? cause.message : String(cause) }),
          ),
        )
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!row) return
      emit("session.updated", row)
      // A chat new to this machine is not open anywhere; an existing one may be,
      // so its open views hear about every message and part that changed.
      if (input.expected) announceContent(row, incoming, previous)
    })

    const remove = Effect.fn("MachineSyncStore.remove")(function* (input: {
      sessionID: SessionID
      timeDeleted: number
      expected: Version | null
    }) {
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* admit(input.sessionID, input.expected)
            const found = yield* tx
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            yield* tx
              .delete(EventSequenceTable)
              .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
              .run()
              .pipe(Effect.orDie)
            yield* tx.delete(SessionTable).where(eq(SessionTable.id, input.sessionID)).run().pipe(Effect.orDie)
            yield* tx
              .insert(SessionTombstoneTable)
              .values({ id: input.sessionID, time_deleted: input.timeDeleted })
              .onConflictDoUpdate({ target: SessionTombstoneTable.id, set: { time_deleted: input.timeDeleted } })
              .run()
              .pipe(Effect.orDie)
            return found
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
      if (row) emit("session.deleted", row)
    })

    const archive = Effect.fn("MachineSyncStore.archive")(function* (input: {
      sessionID: SessionID
      timeArchived: number
      expected: Version | null
    }) {
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* admit(input.sessionID, input.expected)
            const found = yield* tx
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!found) return undefined
            // time_updated has an $onUpdate default; pin it so archiving here does
            // not look like a newer local edit to the peer.
            yield* tx
              .update(SessionTable)
              .set({ time_archived: input.timeArchived, time_updated: found.time_updated })
              .where(eq(SessionTable.id, input.sessionID))
              .run()
              .pipe(Effect.orDie)
            return found
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
      if (row) emit("session.updated", { ...row, time_archived: input.timeArchived })
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

    const idle = Effect.fn("MachineSyncStore.idle")(function* () {
      return (yield* running()).size === 0
    })

    return Service.of({ manifest, bundle, apply, remove, archive, missingDirectories, idle })
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

/** A version precondition from the sync worker: `null` (chat absent) or `{ timeUpdated, timeArchived }`. */
export function isVersion(input: unknown): input is Version | null {
  if (input === null) return true
  if (!isRecord(input) || !isTime(input.timeUpdated)) return false
  return input.timeArchived === null || isTime(input.timeArchived)
}

function isTime(value: unknown) {
  return typeof value === "number" && Number.isInteger(value)
}

function sameVersion(a: Version | null, b: Version | null) {
  if (a === null || b === null) return a === b
  return a.timeUpdated === b.timeUpdated && a.timeArchived === b.timeArchived
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

// Mirrors the legacy message events so an open chat redraws only what the
// apply changed: removed messages and parts go, new or restamped ones are sent.
function announceContent(
  row: SessionRow,
  incoming: Bundle,
  previous: {
    messages: Array<Pick<Bundle["messages"][number], "id" | "time_updated">>
    parts: Array<Pick<Bundle["parts"][number], "id" | "message_id" | "time_updated">>
  },
) {
  const send = (type: string, properties: Record<string, unknown>) =>
    GlobalBus.emit("event", { directory: row.directory, project: row.project_id, payload: { type, properties } })
  const messages = new Map(incoming.messages.map((message) => [message.id, message.time_updated]))
  const parts = new Map(incoming.parts.map((part) => [part.id, part.time_updated]))
  const shownMessages = new Map(previous.messages.map((message) => [message.id, message.time_updated]))
  const shownParts = new Map(previous.parts.map((part) => [part.id, part.time_updated]))
  previous.messages
    .filter((message) => !messages.has(message.id))
    .forEach((message) => send("message.removed", { sessionID: row.id, messageID: message.id }))
  // Parts of a removed message go with it.
  previous.parts
    .filter((part) => !parts.has(part.id) && messages.has(part.message_id))
    .forEach((part) => send("message.part.removed", { sessionID: row.id, messageID: part.message_id, partID: part.id }))
  incoming.messages
    .filter((message) => shownMessages.get(message.id) !== message.time_updated)
    .forEach((message) =>
      send("message.updated", { sessionID: row.id, info: { ...message.data, id: message.id, sessionID: row.id } }),
    )
  incoming.parts
    .filter((part) => shownParts.get(part.id) !== part.time_updated)
    .forEach((part) =>
      send("message.part.updated", {
        sessionID: row.id,
        part: { ...part.data, id: part.id, sessionID: row.id, messageID: part.message_id },
        time: part.time_updated,
      }),
    )
  send("todo.updated", {
    sessionID: row.id,
    todos: incoming.todos.map((todo) => ({ content: todo.content, status: todo.status, priority: todo.priority })),
  })
}
