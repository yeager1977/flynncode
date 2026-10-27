export * as Scheduler from "./scheduler"

import { and, eq, exists, gt, gte, inArray, or, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schedule, Scope } from "effect"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { MessageTable, PartTable, SessionTable } from "@flynncode/core/session/sql"
import { Flock } from "@flynncode/core/util/flock"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, type SessionID } from "@/session/schema"
import { ScheduleStore } from "./store"

export const TICK = Duration.seconds(15)
/** Orphan pruning runs at most this often, and only while jobs exist. */
export const PRUNE_MS = 60_000
/**
 * An unfinished assistant message counts as a running turn while the session (or a subagent it is waiting on) wrote
 * something this recently. A crashed process leaves its row unfinished forever, so the bound lets delivery recover.
 */
export const BUSY_MS = 10 * 60_000
/** A crashed leader's lock is broken after this long without a heartbeat. */
export const LOCK_STALE_MS = 60_000

export interface Interface {
  /** Runs one scheduling pass at `now` (the injected clock by default), whether or not this process leads. */
  readonly tick: (now?: Date) => Effect.Effect<void>
  /** Takes or keeps the machine-wide leader lock and ticks only while holding it; returns whether it ticked. */
  readonly poll: (now?: Date) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/Scheduler") {}

// Process memory, not the environment: a `flynncode run` spawned from a shell tool must never inherit it.
let leaderEligible = false

/**
 * Lets this process compete for scheduler leadership. Only long-lived servers call it: `serve`, `web`, `acp`, the
 * TUI worker and the desktop sidecar. `flynncode run` and the in-process `Server.Default` it (and tests and plugin
 * clients) build never do, so a short-lived process never claims a job and exits mid-turn.
 */
export function enableLeadership() {
  leaderEligible = true
}

/**
 * Builds a scheduler without starting its timer; turns it starts are forked into the caller's scope, and the leader
 * lock is released when that scope closes. Tests make instances directly and drive `tick` or `poll`.
 */
export const make = Effect.fn("Scheduler.make")(function* (options: { now: () => Date; lock?: string }) {
  const store = yield* ScheduleStore.Service
  const sessions = yield* Session.Service
  const prompts = yield* SessionPrompt.Service
  const instances = yield* InstanceStore.Service
  const { db } = yield* Database.Service
  const scope = yield* Scope.Scope
  // One leader per database file: other channels' servers schedule their own databases.
  const lock = options.lock ?? `schedule:${Database.path()}`
  const state: { lease?: Flock.Lease; pruned?: number } = {}

  yield* Effect.addFinalizer(() =>
    Effect.promise(() => state.lease?.release().catch(() => undefined) ?? Promise.resolve()),
  )

  // A prompt is promoted once the session has an assistant message newer than it: the drain read it as the latest
  // user input. A missing message (reverted or deleted) is not pending.
  const pending = Effect.fnUntraced(function* (sessionID: SessionID, messageID: MessageID) {
    const rows = yield* db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, sessionID),
          or(
            eq(MessageTable.id, messageID),
            and(gt(MessageTable.id, messageID), sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`),
          ),
        ),
      )
      .limit(2)
      .all()
      .pipe(Effect.orDie)
    return rows.length === 1 && rows[0]?.id === messageID
  })

  // Run state is per process, so the database is the only view of a turn another process is driving. Rows carry
  // wall-clock stamps, so recency is measured against the wall clock rather than the scheduling clock.
  const busy = Effect.fnUntraced(function* (sessionID: SessionID) {
    const since = Date.now() - BUSY_MS
    const row = yield* db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, sessionID),
          sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
          sql`json_extract(${MessageTable.data}, '$.time.completed') IS NULL`,
          or(
            gte(MessageTable.time_updated, since),
            exists(
              db
                .select({ id: PartTable.id })
                .from(PartTable)
                .where(
                  and(
                    or(
                      eq(PartTable.session_id, sessionID),
                      inArray(
                        PartTable.session_id,
                        db
                          .select({ id: SessionTable.id })
                          .from(SessionTable)
                          .where(eq(SessionTable.parent_id, sessionID)),
                      ),
                    ),
                    gte(PartTable.time_updated, since),
                  ),
                ),
            ),
          ),
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    return row !== undefined
  })

  const fire = Effect.fnUntraced(function* (job: ScheduleStore.Job, session: Session.Info, now: Date) {
    const inSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      instances.provide({ directory: session.directory }, effect)
    // The loop starts a turn for a session that is idle by the database; it is forked so a turn never holds up the
    // tick. When some process is mid-turn the queued prompt is only admitted: that drain re-reads the database each
    // step and promotes it, and a second loop here would answer it in parallel.
    const drain = Effect.gen(function* () {
      if (yield* busy(session.id)) return
      yield* inSession(prompts.loop({ sessionID: session.id })).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("scheduled turn failed", { "session.id": session.id, cause: Cause.pretty(cause) }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })
    if (job.pending_message_id && (yield* pending(session.id, MessageID.make(job.pending_message_id)))) {
      yield* Effect.logInfo("scheduled prompt skipped; the previous one is still pending", { job: job.id })
      const skipped = yield* store.skip(job, now)
      // An idle session with a pending prompt was stranded by a process that exited mid-turn.
      yield* drain
      return skipped
    }
    // Admission only, so a failure here is a delivery failure; the turn runs in `drain`. The queue delivery keeps
    // the conversation's agent, and the session's model and variant are passed so the prompt does not reset them.
    const message = yield* inSession(
      prompts.prompt({
        sessionID: session.id,
        delivery: "queue",
        noReply: true,
        ...(session.model
          ? {
              model: { providerID: session.model.providerID, modelID: session.model.id },
              variant: session.model.variant === "default" ? undefined : session.model.variant,
            }
          : {}),
        parts: [
          {
            type: "text",
            synthetic: true,
            text: job.prompt,
            metadata: {
              schedule: {
                id: job.id,
                kind: job.kind,
                ...(job.cron ? { cron: job.cron } : {}),
                ...(job.reason ? { reason: job.reason } : {}),
              },
            },
          },
        ],
      }),
    ).pipe(Effect.orDie)
    const completed = yield* store.complete(job, { now, messageID: message.info.id })
    if (!completed) yield* Effect.logWarning("scheduled job lease lapsed during delivery", { job: job.id })
    yield* drain
    return completed
  })

  const deliver = Effect.fnUntraced(function* (job: ScheduleStore.Job, session: Session.Info, now: Date) {
    const result = yield* fire(job, session, now).pipe(Effect.exit)
    if (Exit.isSuccess(result)) {
      if (result.value) yield* ScheduleStore.publishUpdated({ directory: session.directory, sessionID: session.id })
      return
    }
    yield* Effect.logWarning("scheduled prompt delivery failed", {
      job: job.id,
      "session.id": job.session_id,
      failures: job.failures + 1,
      cause: Cause.pretty(result.cause),
    })
    const counted = yield* store.fail(job)
    if (counted && job.failures + 1 >= ScheduleStore.MAX_FAILURES)
      yield* Effect.logWarning("scheduled job deleted after repeated delivery failures", { job: job.id })
  })

  // Each job gets its own lease, taken after its instance is warm, so a slow boot for one job never eats into
  // another's lease.
  const attempt = Effect.fnUntraced(function* (candidate: ScheduleStore.Job, clock: () => Date) {
    const found = yield* sessions.get(candidate.session_id).pipe(Effect.option)
    // A missing or archived session is pruned; a pending revert defers the job, because admitting a prompt
    // commits the revert, which the user may still want to undo. The job fires once the revert is resolved.
    if (Option.isNone(found) || found.value.time.archived !== undefined || found.value.revert) return
    const session = found.value
    yield* instances.provide({ directory: session.directory }, Effect.void).pipe(Effect.exit)
    const now = clock()
    const job = yield* store.claim(candidate.id, now)
    if (!job) return
    yield* deliver(job, session, now)
  })

  // Removed jobs announce themselves in their session's directory when the session still exists.
  const announce = Effect.fnUntraced(function* (jobs: ScheduleStore.Job[]) {
    const ids = [...new Set(jobs.map((job) => job.session_id))]
    yield* Effect.forEach(ids, (id) =>
      sessions.get(id).pipe(
        Effect.flatMap((session) => ScheduleStore.publishUpdated({ directory: session.directory, sessionID: id })),
        Effect.catch(() => Effect.void),
      ),
    )
  })

  const tick = Effect.fn("Scheduler.tick")(function* (at?: Date) {
    const clock = () => at ?? options.now()
    const now = clock()
    // An idle tick is this one read.
    const summary = yield* store.summary()
    if (summary.count === 0) return
    if (summary.expires !== null && summary.expires <= now.getTime()) {
      const expired = yield* store.expire(now)
      if (expired.length > 0) yield* Effect.logInfo("scheduled jobs expired", { jobs: expired.map((job) => job.id) })
      yield* announce(expired)
    }
    if (state.pruned === undefined || now.getTime() - state.pruned >= PRUNE_MS) {
      state.pruned = now.getTime()
      const orphaned = yield* store.prune()
      if (orphaned.length > 0)
        yield* Effect.logInfo("scheduled jobs deleted with their session", { jobs: orphaned.map((job) => job.id) })
      yield* announce(orphaned)
    }
    if (summary.next === null || summary.next > now.getTime()) return
    const due = yield* store.due(now)
    yield* Effect.forEach(due, (job) => attempt(job, clock), { discard: true })
  })

  const poll = Effect.fn("Scheduler.poll")(function* (at?: Date) {
    // Tries once and never waits: the next poll tries again, so a new leader takes over when the old one exits.
    state.lease ??= yield* Effect.promise(() =>
      Flock.acquire(lock, { staleMs: LOCK_STALE_MS, timeoutMs: 0 }).catch(() => undefined),
    )
    if (!state.lease) return false
    yield* tick(at)
    return true
  })

  return Service.of({ tick, poll })
})

/** The process-global scheduler: one timer per server graph, stopped with the server's layer scope. */
export const layer = (now: () => Date = () => new Date()) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const scheduler = yield* make({ now })
      // Eligibility is read on every poll, so an entry point may opt in after the graph is built. A failing poll
      // is logged and never takes the timer down.
      yield* Effect.suspend(() => (leaderEligible ? scheduler.poll() : Effect.void)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("scheduler tick failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(TICK)),
        Effect.delay(TICK),
        Effect.forkScoped,
      )
      return scheduler
    }),
  )

export const node = LayerNode.make({
  service: Service,
  layer: layer(),
  deps: [ScheduleStore.node, Session.node, SessionPrompt.node, InstanceStore.node, Database.node],
})
