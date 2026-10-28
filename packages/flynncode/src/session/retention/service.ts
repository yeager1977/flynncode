export * as SessionRetention from "./service"

import path from "path"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schedule, Schema } from "effect"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { FSUtil } from "@flynncode/core/fs-util"
import { Global } from "@flynncode/core/global"
import { Flock } from "@flynncode/core/util/flock"
import { SessionRetention as RetentionSchema } from "@flynncode/schema/session-retention"
import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { ScheduleStore } from "@/schedule/store"
import { SessionRemoval } from "@/session/removal"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { BackgroundShells } from "@/shell/background/service"
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
/** A first pass that finds more deletable trees than this waits `FIRST_RUN_DELAY_MS` before deleting. */
export const FIRST_RUN_LIMIT = 20
export const FIRST_RUN_DELAY_MS = DAY
/** `status` lists trees due within this long. */
export const EXPIRING_MS = 3 * DAY
/** A crashed leader's lock is broken after this long without a heartbeat. */
export const LOCK_STALE_MS = 60_000

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
  /** Set while the first run is delayed: nothing is deleted before this time. */
  delayedUntil?: number
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

// The first-run bookkeeping. `completedAt` is set once the first pass deletes (or finds nothing to delete); until
// then a delayed first run keeps `firstRunAt` (when it deletes) and `pendingFirstRunCount`.
const State = Schema.Struct({
  firstRunAt: Schema.optional(Schema.Finite),
  pendingFirstRunCount: Schema.optional(Schema.Finite),
  completedAt: Schema.optional(Schema.Finite),
})
type State = typeof State.Type
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(State))

/** The first-run state file: one per database file, so each channel's database has its own first run. */
export function defaultStatePath() {
  return path.join(Global.Path.state, `session-retention-${path.parse(Database.path()).name}.json`)
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

/**
 * Builds the retention service without starting its timer. The leader lock is released when the caller's scope
 * closes. Tests make instances directly with their own clock, lock and state file, and drive `pass` or `poll`.
 */
export const make = Effect.fn("SessionRetention.make")(function* (options: {
  now: () => Date
  lock?: string
  /** The first-run state file, `defaultStatePath()` by default. */
  statePath?: string
}) {
  const sessions = yield* Session.Service
  const worktrees = yield* Worktree.Service
  const instances = yield* InstanceStore.Service
  const status = yield* SessionStatus.Service
  const fs = yield* FSUtil.Service
  const project = yield* Project.Service
  const shells = yield* BackgroundShells.Service
  const config = yield* Config.Service
  const database = yield* Database.Service
  const removal = { sessions, worktrees, store: instances, status, fs, project }
  const statePath = options.statePath ?? defaultStatePath()
  const leader: { lease?: Flock.Lease } = {}

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

  // Background shells live in this process only. A shell another process runs is not seen here, but its output
  // notifications write parts into the session, so its tree stays active anyway.
  const running = Effect.fnUntraced(function* (tree: SessionRetentionQuery.Tree) {
    const lists = yield* Effect.forEach(tree.members, (id) => shells.list(id))
    return lists.some((list) => list.some((shell) => shell.status === "running"))
  })

  // A tree is deleted once its newest write is `days` old. A write in the future (clock skew) keeps it.
  const deletesAt = (tree: SessionRetentionQuery.Tree, days: number) => tree.latest + days * DAY

  const exempt = Effect.fnUntraced(function* (tree: SessionRetentionQuery.Tree) {
    if (tree.keep || tree.scheduled) return true
    return yield* running(tree)
  })

  // Oldest first, so a capped pass deletes the longest-inactive trees.
  const eligible = Effect.fnUntraced(function* (trees: SessionRetentionQuery.Tree[], now: number, days: number) {
    const due = trees.filter((tree) => deletesAt(tree, days) <= now).toSorted((a, b) => a.latest - b.latest)
    return yield* Effect.filter(due, (tree) => exempt(tree).pipe(Effect.map((skip) => !skip)))
  })

  // Re-reads the tree right before deleting it: a session may have been written to since the pass read it. The
  // manual delete runs in the root's instance. When that instance cannot load (its folder is gone, or its project
  // config is broken), the tree is still removed with its tombstones, only without hooks or worktree disposal, so one
  // broken project never blocks every later pass.
  const removeTree = Effect.fnUntraced(function* (id: SessionRetentionQuery.Tree["id"], now: number, days: number) {
    const current = (yield* SessionRetentionQuery.trees(database, now, id)).at(0)
    if (!current || deletesAt(current, days) > now || (yield* exempt(current))) return 0
    const loaded =
      (yield* fs.existsSafe(current.directory)) &&
      Exit.isSuccess(yield* instances.load({ directory: current.directory }).pipe(Effect.exit))
    yield* loaded
      ? instances.provide({ directory: current.directory }, SessionRemoval.remove(removal, id))
      : sessions.remove(id)
    return current.members.length
  })

  // The first pass ever that finds more than `FIRST_RUN_LIMIT` trees waits a day, so the owner sees what is coming.
  const gate = Effect.fnUntraced(function* (count: number, now: number) {
    const state = yield* readState()
    if (state.completedAt !== undefined) return undefined
    const firstRunAt = state.firstRunAt ?? (count > FIRST_RUN_LIMIT ? now + FIRST_RUN_DELAY_MS : undefined)
    if (firstRunAt !== undefined && now < firstRunAt) {
      if (state.firstRunAt !== firstRunAt || state.pendingFirstRunCount !== count)
        yield* writeState({ firstRunAt, pendingFirstRunCount: count })
      return firstRunAt
    }
    yield* writeState({ completedAt: now })
    return undefined
  })

  const pass = Effect.fn("SessionRetention.pass")(function* (at?: Date) {
    const now = (at ?? options.now()).getTime()
    const days = yield* period()
    const trees = yield* SessionRetentionQuery.trees(database, now)
    const due = yield* eligible(trees, now, days)
    const delayedUntil = yield* gate(due.length, now)
    const results =
      delayedUntil === undefined
        ? yield* Effect.forEach(due.slice(0, MAX_TREES), (tree) =>
            removeTree(tree.id, now, days).pipe(
              Effect.exit,
              Effect.tap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.logWarning("session retention could not delete a session tree", {
                      "session.id": tree.id,
                      cause: Cause.pretty(exit.cause),
                    })
                  : Effect.void,
              ),
            ),
          )
        : []
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
    }
    yield* Effect.logInfo("session retention pass", summary)
    yield* publishUpdated()
    return summary
  })

  const poll = Effect.fn("SessionRetention.poll")(function* (at?: Date) {
    // Tries once and never waits: the next poll tries again, so another server takes over when the leader exits. One
    // leader per database file, whatever kind of server it is.
    leader.lease ??= yield* Effect.promise(() =>
      Flock.acquire(options.lock ?? `session-retention:${Database.path()}`, {
        staleMs: LOCK_STALE_MS,
        timeoutMs: 0,
      }).catch(() => undefined),
    )
    if (!leader.lease) return false
    yield* pass(at)
    return true
  })

  const statusOf = Effect.fn("SessionRetention.status")(function* (at?: Date) {
    const now = (at ?? options.now()).getTime()
    const days = yield* period()
    const state = yield* readState()
    const pending = state.completedAt === undefined ? state.firstRunAt : undefined
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
 * process that opted into scheduler leadership (`Scheduler.enableLeadership`: the desktop sidecar, the TUI worker and
 * `serve`/`web`/`acp`) polls; `flynncode run`, plugin clients and tests never delete anything.
 */
export const layer = (now: () => Date = () => new Date()) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const retention = yield* make({ now })
      // A failing pass is logged and the next one runs on schedule.
      yield* Effect.suspend(() => (ScheduleStore.processOwner() ? retention.poll() : Effect.void)).pipe(
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
  deps: [
    Session.node,
    Worktree.node,
    InstanceStore.node,
    SessionStatus.node,
    FSUtil.node,
    Project.node,
    BackgroundShells.node,
    Config.node,
    Database.node,
  ],
})
