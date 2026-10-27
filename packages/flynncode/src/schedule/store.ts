export * as ScheduleStore from "./store"

import { and, asc, eq, isNotNull, isNull, lte, lt, or, sql } from "drizzle-orm"
import { Cron } from "croner"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionScheduleTable } from "@flynncode/core/session/sql"
import { Identifier } from "@/id/id"
import type { SessionID } from "@/session/schema"

export const MAX_JOBS = 20
export const MAX_FAILURES = 3
export const LEASE_MS = 60_000
export const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export type Job = typeof SessionScheduleTable.$inferSelect

export class LimitError extends Schema.TaggedErrorClass<LimitError>()("ScheduleLimitError", {
  sessionID: Schema.String,
  limit: Schema.Number,
}) {}

export class InvalidCronError extends Schema.TaggedErrorClass<InvalidCronError>()("ScheduleInvalidCronError", {
  cron: Schema.String,
}) {}

export type CreateInput = {
  sessionID: SessionID
  kind: "cron" | "wakeup"
  cron?: string
  prompt: string
  reason?: string
  recurring: boolean
  /** When a wakeup fires; a cron job derives its first run from `cron`. Defaults to `now`. */
  runAt?: Date
  now: Date
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Job, LimitError | InvalidCronError>
  readonly list: (sessionID: SessionID) => Effect.Effect<Job[]>
  readonly remove: (sessionID: SessionID, id: string) => Effect.Effect<boolean>
  readonly removeSession: (sessionID: SessionID) => Effect.Effect<void>
  /** Atomically leases every due job; only the returned rows belong to the caller. */
  readonly claimDue: (now: Date) => Effect.Effect<Job[]>
  /** The prompt was delivered: advance a recurring job, delete a one-shot. */
  readonly complete: (job: Job, input: { now: Date; messageID: string }) => Effect.Effect<void>
  /** The previous prompt is still pending: move a recurring job to its next slot without delivering. */
  readonly skip: (job: Job, now: Date) => Effect.Effect<void>
  /** Delivery failed: count it, release the lease, and delete the job at 3 in a row. */
  readonly fail: (job: Job) => Effect.Effect<void>
  /** Deletes jobs past `expires_at` and returns how many went. */
  readonly expire: (now: Date) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ScheduleStore") {}

/** The first match strictly after `after` for a standard 5-field cron in local time, or undefined. */
export function nextRun(cron: string, after: Date) {
  // croner also takes seconds, years and @nicknames; only 5 fields are supported here.
  if (cron.trim().split(/\s+/).length !== 5) return undefined
  const job = (() => {
    try {
      return new Cron(cron)
    } catch {
      return undefined
    }
  })()
  return job?.nextRun(after) ?? undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const create = Effect.fn("ScheduleStore.create")(function* (input: CreateInput) {
      const first = input.kind === "wakeup" ? (input.runAt ?? input.now) : nextRun(input.cron ?? "", input.now)
      if (!first) return yield* new InvalidCronError({ cron: input.cron ?? "" })
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              // A wakeup replaces the pending one before the limit is counted.
              if (input.kind === "wakeup")
                yield* tx
                  .delete(SessionScheduleTable)
                  .where(
                    and(eq(SessionScheduleTable.session_id, input.sessionID), eq(SessionScheduleTable.kind, "wakeup")),
                  )
                  .run()
              const count = yield* tx
                .select({ count: sql<number>`count(*)` })
                .from(SessionScheduleTable)
                .where(eq(SessionScheduleTable.session_id, input.sessionID))
                .get()
              if ((count?.count ?? 0) >= MAX_JOBS)
                return yield* new LimitError({ sessionID: input.sessionID, limit: MAX_JOBS })
              return yield* tx
                .insert(SessionScheduleTable)
                .values({
                  id: Identifier.ascending("schedule"),
                  session_id: input.sessionID,
                  kind: input.kind,
                  cron: input.kind === "cron" ? (input.cron ?? null) : null,
                  prompt: input.prompt,
                  reason: input.reason ?? null,
                  recurring: input.recurring,
                  next_run_at: first.getTime(),
                  expires_at: input.kind === "cron" && input.recurring ? input.now.getTime() + EXPIRY_MS : null,
                  time_created: input.now.getTime(),
                })
                .returning()
                .get()
            }),
          // Writers in other processes would otherwise race the count.
          { behavior: "immediate" },
        )
        .pipe(
          // Only the limit is a caller error; database failures are defects.
          Effect.catch((error) => (error instanceof LimitError ? Effect.fail(error) : Effect.die(error))),
          Effect.flatMap((job) => (job ? Effect.succeed(job) : Effect.die("schedule insert returned no row"))),
        )
    })

    const list = Effect.fn("ScheduleStore.list")(function* (sessionID: SessionID) {
      return yield* db
        .select()
        .from(SessionScheduleTable)
        .where(eq(SessionScheduleTable.session_id, sessionID))
        .orderBy(asc(SessionScheduleTable.next_run_at), asc(SessionScheduleTable.id))
        .all()
        .pipe(Effect.orDie)
    })

    const remove = Effect.fn("ScheduleStore.remove")(function* (sessionID: SessionID, id: string) {
      const removed = yield* db
        .delete(SessionScheduleTable)
        .where(and(eq(SessionScheduleTable.session_id, sessionID), eq(SessionScheduleTable.id, id)))
        .returning({ id: SessionScheduleTable.id })
        .all()
        .pipe(Effect.orDie)
      return removed.length > 0
    })

    const removeSession = Effect.fn("ScheduleStore.removeSession")(function* (sessionID: SessionID) {
      yield* db
        .delete(SessionScheduleTable)
        .where(eq(SessionScheduleTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
    })

    // One UPDATE decides the claim, so servers sharing the database cannot both win a job.
    const claimDue = Effect.fn("ScheduleStore.claimDue")(function* (now: Date) {
      return yield* db
        .update(SessionScheduleTable)
        .set({ lease_until: now.getTime() + LEASE_MS })
        .where(
          and(
            lte(SessionScheduleTable.next_run_at, now.getTime()),
            or(isNull(SessionScheduleTable.lease_until), lt(SessionScheduleTable.lease_until, now.getTime())),
          ),
        )
        .returning()
        .all()
        .pipe(Effect.orDie)
    })

    // A recurring job whose cron has no further match is done and goes away.
    const advance = Effect.fn("ScheduleStore.advance")(function* (
      job: Job,
      now: Date,
      extra: Partial<typeof SessionScheduleTable.$inferInsert>,
    ) {
      const next = job.recurring && job.cron ? nextRun(job.cron, now) : undefined
      if (!next) {
        yield* db.delete(SessionScheduleTable).where(eq(SessionScheduleTable.id, job.id)).run().pipe(Effect.orDie)
        return
      }
      yield* db
        .update(SessionScheduleTable)
        .set({ ...extra, next_run_at: next.getTime(), lease_until: null })
        .where(eq(SessionScheduleTable.id, job.id))
        .run()
        .pipe(Effect.orDie)
    })

    const complete = Effect.fn("ScheduleStore.complete")(function* (job: Job, input: { now: Date; messageID: string }) {
      yield* advance(job, input.now, { failures: 0, pending_message_id: input.messageID })
    })

    const skip = Effect.fn("ScheduleStore.skip")(function* (job: Job, now: Date) {
      // A one-shot has no next slot; it stays due and fires on a later tick.
      if (!job.recurring) {
        yield* db
          .update(SessionScheduleTable)
          .set({ lease_until: null })
          .where(eq(SessionScheduleTable.id, job.id))
          .run()
          .pipe(Effect.orDie)
        return
      }
      yield* advance(job, now, {})
    })

    const fail = Effect.fn("ScheduleStore.fail")(function* (job: Job) {
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const updated = yield* tx
                .update(SessionScheduleTable)
                .set({ failures: sql`${SessionScheduleTable.failures} + 1`, lease_until: null })
                .where(eq(SessionScheduleTable.id, job.id))
                .returning({ failures: SessionScheduleTable.failures })
                .get()
              if (updated && updated.failures >= MAX_FAILURES)
                yield* tx.delete(SessionScheduleTable).where(eq(SessionScheduleTable.id, job.id)).run()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const expire = Effect.fn("ScheduleStore.expire")(function* (now: Date) {
      const removed = yield* db
        .delete(SessionScheduleTable)
        .where(and(isNotNull(SessionScheduleTable.expires_at), lte(SessionScheduleTable.expires_at, now.getTime())))
        .returning({ id: SessionScheduleTable.id })
        .all()
        .pipe(Effect.orDie)
      return removed.length
    })

    return Service.of({ create, list, remove, removeSession, claimDue, complete, skip, fail, expire })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node],
})
