export * as SessionRetention from "./service"

import { mkdir, writeFile } from "node:fs/promises"
import path from "path"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schedule, Schema } from "effect"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { FSUtil } from "@flynncode/core/fs-util"
import { Global } from "@flynncode/core/global"
import { Flock } from "@flynncode/core/util/flock"
import { SessionRetention as RetentionSchema } from "@flynncode/schema/session-retention"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Config } from "@/config/config"
import { Project } from "@/project/project"
import { SessionRemoval } from "@/session/removal"
import { Session } from "@/session/session"
import { BackgroundShells } from "@/shell/background/service"
import { isRecord } from "@/util/record"
import { Worktree } from "@/worktree"
import { SessionRetentionQuery } from "./query"

const DAY = 24 * 60 * 60 * 1000

/** `cleanupPeriodDays` when the config does not set it. */
export const PERIOD_DAYS = 30
/** The first pass runs this long after launch, then one runs every `INTERVAL`. */
export const FIRST_PASS = Duration.minutes(5)
export const INTERVAL = Duration.hours(1)
/** Trees deleted per pass at most, so a large backlog never stalls the server. */
export const MAX_TREES = 50
/**
 * A pass that would delete more than this many trees at once waits `FIRST_RUN_DELAY_MS` first: the first pass that
 * finds anything, and the first pass after `cleanupPeriodDays` is lowered that makes this many newly eligible.
 */
export const FIRST_RUN_LIMIT = 20
export const FIRST_RUN_DELAY_MS = DAY
/** `status` lists trees due within this long. */
export const EXPIRING_MS = 3 * DAY
/** A crashed leader's lock is broken after this long without a heartbeat. */
export const LOCK_STALE_MS = 60_000
/** While hub sync is set up, passes are skipped once its last successful cycle is older than this. */
export const SYNC_STALE_MS = DAY

export type Summary = {
  cleanupPeriodDays: number
  /** Sessions in the trees the pass read. */
  sessions: number
  trees: number
  /** Trees inactive for the period and not exempt. */
  eligible: number
  deleted: number
  /** Sessions removed with the deleted trees. */
  removed: number
  failed: number
  /** Set while a surge is delayed: nothing is deleted before this time. */
  delayedUntil?: number
  /** Set when the pass deleted nothing because hub sync has not succeeded for `SYNC_STALE_MS`. */
  skipped?: "sync-stale"
}

export interface Interface {
  /** Runs one pass at `now` (the injected clock by default), whether or not this process leads. */
  readonly pass: (now?: Date) => Effect.Effect<Summary>
  /** Takes or keeps the leader lock and runs a pass only while holding it; returns whether it ran. */
  readonly poll: (now?: Date) => Effect.Effect<boolean>
  /** The hint data of `GET /session/retention`. */
  readonly status: (now?: Date) => Effect.Effect<RetentionSchema.Info>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/SessionRetention") {}

// Process memory, not the environment: a `flynncode run` spawned from a shell tool must never inherit it.
const entry = { enabled: false }

/**
 * Lets this process run retention passes. Only the desktop sidecar and the TUI worker call it, since they live as long
 * as their app and read the owner's setting. `serve`, `web`, `acp`, `flynncode run`, plugin clients and tests never
 * delete sessions on their own. `enable(false)` undoes it, for tests.
 */
export function enable(on = true) {
  entry.enabled = on
}

/**
 * Whether this process polls: it opted in and is not the sync hub. The hub holds every machine's chats under its own
 * defaults, and its deletions would reach every machine.
 */
export function enabled() {
  return entry.enabled && !process.env["SYNC_HUB_MODE"]
}

// The first-run bookkeeping, the period the last pass ran with, and the trees this machine put a schedule hold on.
// While a surge is delayed, `firstRunAt` (when it deletes) and `pendingFirstRunCount` are set.
const State = Schema.Struct({
  firstRunAt: Schema.optional(Schema.Finite),
  pendingFirstRunCount: Schema.optional(Schema.Finite),
  completedAt: Schema.optional(Schema.Finite),
  periodDays: Schema.optional(Schema.Finite),
  holds: Schema.optional(Schema.Array(Schema.String)),
})
type State = typeof State.Type
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(State))

// What the desktop's sync worker last reported; see `recordSync`.
const SyncState = Schema.Struct({ paired: Schema.Boolean, lastPull: Schema.optional(Schema.Finite) })
const decodeSync = Schema.decodeUnknownOption(Schema.fromJsonString(SyncState))

/** The retention state file: one per database file, so each channel's database has its own. */
export function defaultStatePath() {
  return path.join(Global.Path.state, `session-retention-${path.parse(Database.path()).name}.json`)
}

/** Where `recordSync` writes, read by every process that runs passes on this database. */
export function defaultSyncPath() {
  return path.join(Global.Path.state, `session-retention-sync-${path.parse(Database.path()).name}.json`)
}

const recorded = { text: "" }

/**
 * Records the hub sync worker's state for retention: whether this machine is paired, and when its last sync cycle
 * (pull, then push) completed. The desktop sidecar calls it after every cycle; it writes only on a change. A plain
 * promise, because the sidecar runs on Node outside any Effect runtime.
 */
export async function recordSync(input: { paired: boolean; lastPull: number | null }) {
  const text = JSON.stringify(input.lastPull === null ? { paired: input.paired } : input)
  if (text === recorded.text) return
  await mkdir(Global.Path.state, { recursive: true })
  await writeFile(defaultSyncPath(), text)
  recorded.text = text
}

/** Publishes `session.retention.updated` to every client; retention is per database, not per instance. */
export function publishUpdated() {
  return Effect.sync(() =>
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: RetentionSchema.Event.Updated.type, properties: {} },
    }),
  ).pipe(Effect.asVoid)
}

const ASKED = new Set(["permission.asked", "permission.v2.asked", "question.asked", "question.v2.asked"])
const ANSWERED = new Set([
  "permission.replied",
  "permission.v2.replied",
  "question.replied",
  "question.rejected",
  "question.v2.replied",
  "question.v2.rejected",
])

/**
 * Builds the retention service without starting its timer. The leader lock is released when the caller's scope
 * closes. Tests make instances directly with their own clock, lock and state files, and drive `pass` or `poll`.
 */
export const make = Effect.fn("SessionRetention.make")(function* (options: {
  now: () => Date
  lock?: string
  /** The state file, `defaultStatePath()` by default. */
  statePath?: string
  /** The sync state file, `defaultSyncPath()` by default. */
  syncPath?: string
}) {
  const sessions = yield* Session.Service
  const worktrees = yield* Worktree.Service
  const fs = yield* FSUtil.Service
  const project = yield* Project.Service
  const shells = yield* BackgroundShells.Service
  const config = yield* Config.Service
  const database = yield* Database.Service
  const removal = { sessions, worktrees, project }
  const statePath = options.statePath ?? defaultStatePath()
  const syncPath = options.syncPath ?? defaultSyncPath()
  const leader: { lease?: Flock.Lease } = {}

  // This process's sessions with a running turn, and its open permission and question prompts. Their services are
  // instance-scoped, but every change crosses the process-wide GlobalBus, so no instance is loaded to read them.
  const live = { running: new Set<string>(), prompts: new Map<string, string>() }
  const track = (event: GlobalEvent) => {
    const payload: unknown = event.payload
    if (!isRecord(payload) || !isRecord(payload.properties) || typeof payload.type !== "string") return
    const properties = payload.properties
    if (typeof properties.sessionID !== "string") return
    const sessionID = properties.sessionID
    const idle =
      payload.type === "session.idle" ||
      (payload.type === "session.status" && isRecord(properties.status) && properties.status.type === "idle")
    if (idle) {
      live.running.delete(sessionID)
      // A prompt only stays open inside a running turn.
      ;[...live.prompts].filter((item) => item[1] === sessionID).forEach((item) => live.prompts.delete(item[0]))
      return
    }
    if (payload.type === "session.status") live.running.add(sessionID)
    if (ASKED.has(payload.type) && typeof properties.id === "string") live.prompts.set(properties.id, sessionID)
    if (ANSWERED.has(payload.type) && typeof properties.requestID === "string")
      live.prompts.delete(properties.requestID)
  }
  GlobalBus.on("event", track)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", track)))

  yield* Effect.addFinalizer(() =>
    Effect.promise(() => leader.lease?.release().catch(() => undefined) ?? Promise.resolve()),
  )

  // Read on every pass, so a changed setting applies to the next one. An invalid config fails to load and dies here,
  // so retention never deletes with a guessed period.
  const period = Effect.fnUntraced(function* () {
    const days = (yield* config.getGlobal()).cleanupPeriodDays ?? PERIOD_DAYS
    if (!Number.isInteger(days) || days < 1) return yield* Effect.die(new Error(`invalid cleanupPeriodDays: ${days}`))
    return days
  })

  const readState = Effect.fnUntraced(function* () {
    const text = yield* fs.readFileStringSafe(statePath).pipe(Effect.orElseSucceed(() => undefined))
    return text === undefined ? {} : Option.getOrElse(decodeState(text), (): State => ({}))
  })

  const writeState = (state: State) => fs.writeWithDirs(statePath, JSON.stringify(state)).pipe(Effect.orDie)

  // Hub sync set up but silent for a day: this machine may lack newer copies of what it would delete. An unreadable
  // record counts as stale; the sidecar rewrites it after its next cycle.
  const syncStale = Effect.fnUntraced(function* (now: number) {
    const text = yield* fs.readFileStringSafe(syncPath).pipe(Effect.orElseSucceed(() => undefined))
    if (text === undefined) return false
    const sync = decodeSync(text)
    if (Option.isNone(sync)) return true
    if (!sync.value.paired) return false
    return sync.value.lastPull === undefined || now - sync.value.lastPull > SYNC_STALE_MS
  })

  // Background shells live in this process only. A shell another process runs is not seen here, but its output
  // notifications write parts into the session, and its turn's assistant message stays unfinished.
  const shelled = Effect.fnUntraced(function* (tree: SessionRetentionQuery.Tree) {
    const lists = yield* Effect.forEach(tree.members, (id) => shells.list(id))
    return lists.some((list) => list.some((shell) => shell.status === "running"))
  })

  // A turn that runs in this process, waits on a prompt here, or is unfinished in the database (another process may
  // drive it). A turn waiting on the user writes nothing, so inactivity alone would not protect it.
  const busy = Effect.fnUntraced(function* (tree: SessionRetentionQuery.Tree) {
    const active = new Set([...live.running, ...live.prompts.values()])
    if (tree.members.some((id) => active.has(id))) return true
    if (yield* shelled(tree)) return true
    return yield* SessionRetentionQuery.unfinished(database, tree.members)
  })

  // A tree is deleted once its newest write is `days` old. A write in the future (clock skew) keeps it.
  const deletesAt = (tree: SessionRetentionQuery.Tree, days: number) => tree.latest + days * DAY

  const exempt = Effect.fnUntraced(function* (tree: SessionRetentionQuery.Tree) {
    if (tree.keep || tree.hold || tree.scheduled) return true
    return yield* busy(tree)
  })

  // Oldest first, so a capped pass deletes the longest-inactive trees.
  const eligible = Effect.fnUntraced(function* (trees: SessionRetentionQuery.Tree[], now: number, days: number) {
    const due = trees.filter((tree) => deletesAt(tree, days) <= now).toSorted((a, b) => a.latest - b.latest)
    return yield* Effect.filter(due, (tree) => exempt(tree).pipe(Effect.map((skip) => !skip)))
  })

  // Mirrors this database's scheduled jobs into the synced `retentionHold` flag on their trees' roots, so a machine
  // without the job never deletes the tree. Only holds this machine set are cleared, once its last job there is gone
  // or expired: a hold synced from a machine whose job still runs is never touched here. Writing the flag counts as
  // activity, which also carries it to the other machines.
  const holds = Effect.fnUntraced(function* (trees: SessionRetentionQuery.Tree[], now: number) {
    const state = yield* readState()
    const mine = new Set(state.holds ?? [])
    const changes = [
      ...trees.filter((tree) => tree.scheduled && !tree.hold).map((tree) => ({ id: tree.id, hold: true })),
      ...trees
        .filter((tree) => !tree.scheduled && tree.hold && mine.has(tree.id))
        .map((tree) => ({ id: tree.id, hold: false })),
    ]
    yield* Effect.forEach(
      changes,
      (change) =>
        sessions
          .updateMetadata({
            sessionID: change.id,
            update: (metadata) =>
              change.hold
                ? { ...metadata, retentionHold: true }
                : Object.fromEntries(Object.entries(metadata).filter((item) => item[0] !== "retentionHold")),
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session retention could not update a schedule hold", {
                "session.id": change.id,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
      { discard: true },
    )
    const wanted = trees.filter((tree) => tree.scheduled).map((tree) => tree.id)
    if (wanted.length !== mine.size || wanted.some((id) => !mine.has(id)))
      yield* writeState({ ...state, holds: wanted })
    if (changes.length === 0) return trees
    return yield* SessionRetentionQuery.trees(database, now)
  })

  // Re-reads the tree right before deleting it, with nothing in between: a session may have been written to, kept,
  // scheduled or started since the pass read it. Nothing is loaded; see `SessionRemoval.removeDetached`. The
  // tombstones carry the activity judged here, so they never outrank a newer copy on another machine.
  const removeTree = Effect.fnUntraced(function* (id: SessionRetentionQuery.Tree["id"], now: number, days: number) {
    const current = (yield* SessionRetentionQuery.trees(database, now, id)).at(0)
    if (!current || deletesAt(current, days) > now || (yield* exempt(current))) return 0
    yield* SessionRemoval.removeDetached(removal, id, current.latest)
    return current.members.length
  })

  const removeAll = Effect.fnUntraced(function* (
    due: SessionRetentionQuery.Tree[],
    now: number,
    days: number,
    leads: Effect.Effect<boolean>,
  ) {
    const results: Exit.Exit<number, unknown>[] = []
    for (const tree of due.slice(0, MAX_TREES)) {
      // A stall can hand leadership to another process mid-pass; that process runs its own passes.
      if (!(yield* leads)) break
      const exit = yield* removeTree(tree.id, now, days).pipe(Effect.exit)
      if (Exit.isFailure(exit))
        yield* Effect.logWarning("session retention could not delete a session tree", {
          "session.id": tree.id,
          cause: Cause.pretty(exit.cause),
        })
      results.push(exit)
    }
    return results
  })

  // A surge waits a day so the owner sees what is coming: the first pass that finds more than `FIRST_RUN_LIMIT` trees,
  // and a pass after `cleanupPeriodDays` was lowered that makes more than `FIRST_RUN_LIMIT` trees newly eligible. A
  // pass with nothing to delete spends neither, and drops a pending delay that no longer applies.
  const gate = Effect.fnUntraced(function* (due: SessionRetentionQuery.Tree[], now: number, days: number) {
    const state = yield* readState()
    const settled = { completedAt: state.completedAt, periodDays: state.periodDays, holds: state.holds }
    // State written before `periodDays` was recorded may come from a first pass that found nothing.
    const first = state.completedAt === undefined || state.periodDays === undefined
    if (due.length === 0) {
      const next = first ? settled : { ...settled, periodDays: days }
      if (state.firstRunAt !== undefined || next.periodDays !== state.periodDays) yield* writeState(next)
      return undefined
    }
    if (state.firstRunAt !== undefined && now >= state.firstRunAt) {
      yield* writeState({ ...settled, completedAt: now, periodDays: days })
      return undefined
    }
    if (state.firstRunAt !== undefined) {
      if (state.pendingFirstRunCount !== due.length) yield* writeState({ ...state, pendingFirstRunCount: due.length })
      return state.firstRunAt
    }
    // Under a lower period than the last pass used, the trees that period would not yet delete are newly eligible.
    const surge = first ? due.length : due.filter((tree) => deletesAt(tree, state.periodDays ?? days) > now).length
    if (surge > FIRST_RUN_LIMIT) {
      yield* writeState({ ...state, firstRunAt: now + FIRST_RUN_DELAY_MS, pendingFirstRunCount: due.length })
      return now + FIRST_RUN_DELAY_MS
    }
    if (first || state.periodDays !== days)
      yield* writeState({ ...settled, completedAt: first ? now : state.completedAt, periodDays: days })
    return undefined
  })

  const run = Effect.fnUntraced(function* (at: Date | undefined, leads: Effect.Effect<boolean>) {
    const now = (at ?? options.now()).getTime()
    const trees = yield* holds(yield* SessionRetentionQuery.trees(database, now), now)
    const days = yield* period()
    const due = yield* eligible(trees, now, days)
    const stale = yield* syncStale(now)
    const delayedUntil = stale ? undefined : yield* gate(due, now, days)
    const results = stale || delayedUntil !== undefined ? [] : yield* removeAll(due, now, days, leads)
    const removed = results.flatMap((exit) => (Exit.isSuccess(exit) && exit.value > 0 ? [exit.value] : []))
    const summary: Summary = {
      cleanupPeriodDays: days,
      sessions: trees.reduce((sum, tree) => sum + tree.members.length, 0),
      trees: trees.length,
      eligible: due.length,
      deleted: removed.length,
      removed: removed.reduce((sum, count) => sum + count, 0),
      failed: results.filter(Exit.isFailure).length,
      ...(delayedUntil === undefined ? {} : { delayedUntil }),
      ...(stale ? { skipped: "sync-stale" as const } : {}),
    }
    yield* Effect.logInfo("session retention pass", summary)
    yield* publishUpdated()
    return summary
  })

  const pass = Effect.fn("SessionRetention.pass")(function* (at?: Date) {
    return yield* run(at, Effect.succeed(true))
  })

  // False once another process broke this lease as stale (after a suspend or a stall past `LOCK_STALE_MS`). The lease
  // is dropped then: releasing it stops its heartbeat, and the lock itself, now someone else's, stays.
  const leads = Effect.suspend(() => {
    const lease = leader.lease
    if (!lease) return Effect.succeed(false)
    return Effect.promise(() => lease.held()).pipe(
      Effect.tap((held) =>
        held
          ? Effect.void
          : Effect.promise(() => lease.release().catch(() => undefined)).pipe(
              Effect.andThen(Effect.sync(() => (leader.lease = undefined))),
            ),
      ),
    )
  })

  const poll = Effect.fn("SessionRetention.poll")(function* (at?: Date) {
    // Tries once and never waits: the next poll tries again, so another server takes over when the leader exits. One
    // leader per database file, whatever kind of server it is.
    if (leader.lease) yield* leads
    leader.lease ??= yield* Effect.promise(() =>
      Flock.acquire(options.lock ?? `session-retention:${Database.path()}`, {
        staleMs: LOCK_STALE_MS,
        timeoutMs: 0,
      }).catch(() => undefined),
    )
    if (!leader.lease) return false
    yield* run(at, leads)
    return true
  })

  const statusOf = Effect.fn("SessionRetention.status")(function* (at?: Date) {
    const now = (at ?? options.now()).getTime()
    const days = yield* period()
    const state = yield* readState()
    const pending = state.firstRunAt
    const trees = yield* SessionRetentionQuery.trees(database, now)
    const soon = trees.filter((tree) => Math.max(deletesAt(tree, days), pending ?? 0) - now <= EXPIRING_MS)
    const due = yield* Effect.filter(soon, (tree) => exempt(tree).pipe(Effect.map((skip) => !skip)))
    return {
      cleanupPeriodDays: days,
      ...(pending === undefined ? {} : { firstRunAt: pending, pendingFirstRunCount: state.pendingFirstRunCount ?? 0 }),
      expiring: due
        .map((tree) => ({ sessionID: tree.id, deletesAt: Math.max(deletesAt(tree, days), pending ?? 0) }))
        .toSorted((a, b) => a.deletesAt - b.deletesAt),
      kept: trees.filter((tree) => tree.keep).map((tree) => tree.id),
    }
  })

  return Service.of({ pass, poll, status: statusOf })
})

/**
 * The process-global retention service: one timer per server graph, stopped with the server's layer scope. Only a
 * process that called `enable()` (the desktop sidecar and the TUI worker) polls, and never the sync hub.
 */
export const layer = (now: () => Date = () => new Date()) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const retention = yield* make({ now })
      // A failing pass is logged and the next one runs on schedule.
      yield* Effect.suspend(() => (enabled() ? retention.poll() : Effect.void)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("session retention pass failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(INTERVAL)),
        Effect.delay(FIRST_PASS),
        Effect.forkScoped,
      )
      return retention
    }),
  )

export const node = LayerNode.make({
  service: Service,
  layer: layer(),
  deps: [Session.node, Worktree.node, FSUtil.node, Project.node, BackgroundShells.node, Config.node, Database.node],
})
