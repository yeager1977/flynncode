export * as Scheduler from "./scheduler"

import { and, desc, eq, gt, gte, inArray, or, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schedule, Scope } from "effect"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { MessageTable, PartTable, SessionTable } from "@flynncode/core/session/sql"
import { Flock } from "@flynncode/core/util/flock"
import { Command } from "@/command"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { MessageID, type SessionID } from "@/session/schema"
import { ScheduleStore } from "./store"

export const TICK = Duration.seconds(15)
/** Orphan pruning runs at most this often, and only while jobs exist. */
export const PRUNE_MS = 60_000
/**
 * The session's latest assistant message, unfinished, counts as a turn another process is running while it (or a
 * subagent session started after it) wrote something this recently. A crashed process leaves its row unfinished
 * forever, so the bound lets delivery resume; until then the job is only delayed, never delivered into the turn.
 */
export const BUSY_MS = 10 * 60_000
/** A crashed leader's lock is broken after this long without a heartbeat. */
export const LOCK_STALE_MS = 60_000

export interface Interface {
  /** Runs one scheduling pass at `now` (the injected clock by default), whether or not this process leads. */
  readonly tick: (now?: Date) => Effect.Effect<void>
  /** Takes or keeps the leader lock of this process's kind and ticks only while holding it; returns whether it ticked. */
  readonly poll: (now?: Date) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/Scheduler") {}

/**
 * Lets this process compete for scheduler leadership of its kind. Only long-lived servers call it: `serve`, `web` and
 * `acp` as `serve`, the TUI worker as `tui`, and the desktop sidecar as `sidecar`. Each kind has its own leader and
 * delivers only the jobs its kind created, so a scheduled turn runs where its clients are. `flynncode run` and the
 * in-process `Server.Default` it (and tests and plugin clients) build never call it, so a short-lived process never
 * claims a job and exits mid-turn.
 */
export function enableLeadership(owner: ScheduleStore.Owner) {
  ScheduleStore.adoptOwner(owner)
}

/**
 * Builds a scheduler without starting its timer; turns it starts are forked into the caller's scope, and the leader
 * lock is released when that scope closes. It serves `owner`'s jobs, by default this process's kind (the sidecar for
 * a process that never opted in). Tests make instances directly and drive `tick` or `poll`.
 */
export const make = Effect.fn("Scheduler.make")(function* (options: {
  now: () => Date
  lock?: string
  owner?: ScheduleStore.Owner
}) {
  const store = yield* ScheduleStore.Service
  const sessions = yield* Session.Service
  const prompts = yield* SessionPrompt.Service
  const commands = yield* Command.Service
  const statuses = yield* SessionStatus.Service
  const instances = yield* InstanceStore.Service
  const { db } = yield* Database.Service
  const scope = yield* Scope.Scope
  // Read on every pass: an entry point may opt in after the graph is built.
  const owner = () => options.owner ?? ScheduleStore.processOwner() ?? "sidecar"
  const state: { lease?: Flock.Lease; pruned?: number } = {}
  // Sessions whose turn this scheduler started and is still running: exact even before the run state reports busy.
  const driving = new Set<SessionID>()

  yield* Effect.addFinalizer(() =>
    Effect.promise(() => state.lease?.release().catch(() => undefined) ?? Promise.resolve()),
  )

  // A prompt is promoted once the session has an assistant message newer than it that answers it or a later prompt:
  // the drain read it as (or before) the latest user input. A compaction summary answers an earlier prompt, so it
  // does not count. A missing message (reverted or deleted) is not pending.
  const pending = Effect.fnUntraced(function* (sessionID: SessionID, messageID: MessageID) {
    const rows = yield* db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, sessionID),
          or(
            eq(MessageTable.id, messageID),
            and(
              gt(MessageTable.id, messageID),
              sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
              sql`json_extract(${MessageTable.data}, '$.parentID') >= ${messageID}`,
            ),
          ),
        ),
      )
      .limit(2)
      .all()
      .pipe(Effect.orDie)
    return rows.length === 1 && rows[0]?.id === messageID
  })

  // This process's run state is exact for the turns it drives. The database is the only view of a turn another
  // process drives, and there only the latest assistant message can be live: an unfinished one followed by a newer
  // assistant message was orphaned by a crash. A newer user message does not end a turn, since prompts are queued
  // into running turns. Rows carry wall-clock stamps, so recency is measured against the wall clock.
  const busy = Effect.fnUntraced(function* (session: Session.Info) {
    if (driving.has(session.id)) return true
    const status = yield* instances.provide({ directory: session.directory }, statuses.get(session.id))
    if (status.type !== "idle") return true
    const latest = yield* db
      .select({
        id: MessageTable.id,
        time_created: MessageTable.time_created,
        time_updated: MessageTable.time_updated,
        completed: sql<number | null>`json_extract(${MessageTable.data}, '$.time.completed')`,
      })
      .from(MessageTable)
      .where(
        and(eq(MessageTable.session_id, session.id), sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`),
      )
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!latest || latest.completed !== null) return false
    const since = Date.now() - BUSY_MS
    if (latest.time_updated >= since) return true
    const recent = yield* db
      .select({ id: PartTable.id })
      .from(PartTable)
      .where(
        and(
          gte(PartTable.time_updated, since),
          or(
            eq(PartTable.message_id, latest.id),
            inArray(
              PartTable.session_id,
              db
                .select({ id: SessionTable.id })
                .from(SessionTable)
                .where(
                  and(eq(SessionTable.parent_id, session.id), gte(SessionTable.time_created, latest.time_created)),
                ),
            ),
          ),
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    return recent !== undefined
  })

  // Returns whether the job changed in a way its session's clients should re-list.
  const fire = Effect.fnUntraced(function* (job: ScheduleStore.Job, session: Session.Info, now: Date) {
    const inSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      instances.provide({ directory: session.directory }, effect)
    // Forked so a turn never holds up the tick. Callers only drain a session that is idle.
    const drain = Effect.suspend(() => {
      driving.add(session.id)
      return inSession(prompts.loop({ sessionID: session.id })).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("scheduled turn failed", { "session.id": session.id, cause: Cause.pretty(cause) }),
        ),
        Effect.ensuring(Effect.sync(() => driving.delete(session.id))),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })
    // A prompt admitted into a running turn would steer it, so a busy session gets nothing: a recurring job moves to
    // its next slot, and a one-shot or wakeup stays due and fires on a later tick once the session is idle.
    if (yield* busy(session)) {
      yield* Effect.logDebug("scheduled prompt held; the session is busy", { job: job.id })
      const skipped = yield* store.skip(job, now)
      return skipped && job.recurring
    }
    if (job.pending_message_id && (yield* pending(session.id, MessageID.make(job.pending_message_id)))) {
      yield* Effect.logInfo("scheduled prompt skipped; the previous one is still pending", { job: job.id })
      const skipped = yield* store.skip(job, now)
      // The session is idle, so the pending prompt was stranded by a process that exited before answering it.
      yield* drain
      return skipped
    }
    const metadata = {
      schedule: {
        id: job.id,
        kind: job.kind,
        ...(job.cron ? { cron: job.cron } : {}),
        ...(job.reason ? { reason: job.reason } : {}),
      },
    }
    const variant = session.model?.variant === "default" ? undefined : session.model?.variant
    // A prompt that starts with a known `/command` runs that command, expanded now, the way the user would have.
    const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(job.prompt.trim())
    const command = slash ? yield* inSession(commands.get(slash[1])) : undefined
    // Admission only, so a failure here is a delivery failure; the turn runs in `drain`. Queue delivery keeps the
    // conversation's agent, and the session's model and variant are passed so the prompt does not reset them.
    const message = yield* inSession(
      command && slash
        ? prompts.command({
            sessionID: session.id,
            command: command.name,
            arguments: slash[2],
            variant,
            scheduled: metadata,
          })
        : prompts.prompt({
            sessionID: session.id,
            delivery: "queue",
            noReply: true,
            ...(session.model
              ? { model: { providerID: session.model.providerID, modelID: session.model.id }, variant }
              : {}),
            parts: [{ type: "text", synthetic: true, text: job.prompt, metadata }],
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
    const kind = owner()
    // An idle tick is this one read.
    const summary = yield* store.summary(kind)
    if (summary.count === 0) return
    if (summary.expires !== null && summary.expires <= now.getTime()) {
      const expired = yield* store.expire(now, kind)
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
    const due = yield* store.due(now, kind)
    yield* Effect.forEach(due, (job) => attempt(job, clock), { discard: true })
  })

  const poll = Effect.fn("Scheduler.poll")(function* (at?: Date) {
    // Tries once and never waits: the next poll tries again, so a new leader takes over when the old one exits. Each
    // kind has its own lock per database file; other channels' servers schedule their own databases.
    const lock = options.lock ?? `scheduler-${owner()}:${Database.path()}`
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
      yield* Effect.suspend(() => (ScheduleStore.processOwner() ? scheduler.poll() : Effect.void)).pipe(
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
  deps: [
    ScheduleStore.node,
    Session.node,
    SessionPrompt.node,
    Command.node,
    SessionStatus.node,
    InstanceStore.node,
    Database.node,
  ],
})
