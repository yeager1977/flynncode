export * as Scheduler from "./scheduler"

import { and, eq, gt, or, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Exit, Layer, Schedule, Scope } from "effect"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { MessageTable } from "@flynncode/core/session/sql"
import { SessionSchedule } from "@flynncode/schema/session-schedule"
import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, type SessionID } from "@/session/schema"
import { ScheduleStore } from "./store"

export const TICK = Duration.seconds(15)

export interface Interface {
  /** Runs one scheduling pass at `now` (the injected clock by default). */
  readonly tick: (now?: Date) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/Scheduler") {}

/**
 * Publishes `session.schedule.updated` on the process-wide bus, routed by the session's directory the way
 * instance events are, so clients re-list the session's jobs.
 */
export function publishUpdated(input: { directory: string; sessionID: SessionID }) {
  return Effect.sync(() =>
    GlobalBus.emit("event", {
      directory: input.directory,
      payload: { type: SessionSchedule.Event.Updated.type, properties: { sessionID: input.sessionID } },
    }),
  ).pipe(Effect.asVoid)
}

/**
 * Builds a scheduler without starting its timer; turns it starts are forked into the caller's scope. Tests make
 * instances directly and drive `tick`.
 */
export const make = Effect.fn("Scheduler.make")(function* (options: { now: () => Date }) {
  const store = yield* ScheduleStore.Service
  const sessions = yield* Session.Service
  const prompts = yield* SessionPrompt.Service
  const instances = yield* InstanceStore.Service
  const db = (yield* Database.Service).db
  const scope = yield* Scope.Scope

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

  const fire = Effect.fnUntraced(function* (job: ScheduleStore.Job, now: Date) {
    const session = yield* sessions.get(job.session_id).pipe(Effect.orDie)
    const inSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      instances.provide({ directory: session.directory }, effect)
    // The loop joins a running turn or starts one; it is forked so a turn never holds up the tick. It also drains a
    // prompt left unanswered by a process that exited mid-turn.
    const drain = inSession(prompts.loop({ sessionID: session.id })).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("scheduled turn failed", { "session.id": session.id, cause: Cause.pretty(cause) }),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    )
    if (job.pending_message_id && (yield* pending(session.id, MessageID.make(job.pending_message_id)))) {
      yield* Effect.logInfo("scheduled prompt skipped; the previous one is still pending", { job: job.id })
      yield* store.skip(job, now)
      yield* drain
      return session
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
    yield* store.complete(job, { now, messageID: message.info.id })
    yield* drain
    return session
  })

  const deliver = Effect.fnUntraced(function* (job: ScheduleStore.Job, now: Date) {
    const result = yield* fire(job, now).pipe(Effect.exit)
    if (Exit.isSuccess(result))
      return yield* publishUpdated({ directory: result.value.directory, sessionID: result.value.id })
    yield* Effect.logWarning("scheduled prompt delivery failed", {
      job: job.id,
      "session.id": job.session_id,
      failures: job.failures + 1,
      cause: Cause.pretty(result.cause),
    })
    yield* store.fail(job)
    if (job.failures + 1 >= ScheduleStore.MAX_FAILURES)
      yield* Effect.logWarning("scheduled job deleted after repeated delivery failures", { job: job.id })
  })

  // Removed jobs announce themselves in their session's directory when the session still exists.
  const announce = Effect.fnUntraced(function* (jobs: ScheduleStore.Job[]) {
    const ids = [...new Set(jobs.map((job) => job.session_id))]
    yield* Effect.forEach(ids, (id) =>
      sessions.get(id).pipe(
        Effect.flatMap((session) => publishUpdated({ directory: session.directory, sessionID: id })),
        Effect.catch(() => Effect.void),
      ),
    )
  })

  const tick = Effect.fn("Scheduler.tick")(function* (at?: Date) {
    const now = at ?? options.now()
    const expired = yield* store.expire(now)
    if (expired.length > 0) yield* Effect.logInfo("scheduled jobs expired", { jobs: expired.map((job) => job.id) })
    yield* announce(expired)
    const orphaned = yield* store.prune()
    if (orphaned.length > 0)
      yield* Effect.logInfo("scheduled jobs deleted with their session", { jobs: orphaned.map((job) => job.id) })
    yield* announce(orphaned)
    const claimed = yield* store.claimDue(now)
    yield* Effect.forEach(claimed, (job) => deliver(job, now), { discard: true })
  })

  return Service.of({ tick })
})

/** The process-global scheduler: one timer per server process, stopped with the server's layer scope. */
export const layer = (now: () => Date = () => new Date()) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const scheduler = yield* make({ now })
      // A failing tick is logged and never takes the timer down.
      yield* scheduler.tick().pipe(
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
