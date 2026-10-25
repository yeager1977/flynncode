export * as DatabaseMaintenanceNode from "./maintenance-node"

import { sql } from "drizzle-orm"
import { Cause, Duration, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Flag } from "../flag/flag"
import { Database } from "./database"
import { DatabaseMaintenance } from "./maintenance"

type Db = Database.Interface["db"]

export const pass = Effect.fn("DatabaseMaintenance.pass")(function* (db: Db, now: number) {
  const started = Date.now()
  const pruned = yield* step("prune idle sessions", DatabaseMaintenance.pruneIdleSessions(db, { now }), {
    candidates: 0,
    sessions: 0,
    events: 0,
  })
  const orphans = yield* step("sweep orphans", DatabaseMaintenance.sweepOrphans(db), { aggregates: 0, events: 0 })
  const reclaimed = yield* step(
    "reclaim",
    Effect.gen(function* () {
      const freed = yield* DatabaseMaintenance.reclaim(db)
      // incremental_vacuum writes through the WAL, which otherwise stays at its
      // high-water mark until the next truncating checkpoint. Best effort: another
      // process's open reader makes it busy, and the next pass tries again.
      if (freed > 0) yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.ignoreCause)
      const row = yield* db.get<{ page_size: number }>(sql`PRAGMA page_size`)
      return { freed, pageSize: row?.page_size ?? 4096 }
    }),
    { freed: 0, pageSize: 4096 },
  )
  yield* Effect.logInfo("database maintenance pass", {
    candidates: pruned.candidates,
    sessions: pruned.sessions,
    events: pruned.events,
    orphanAggregates: orphans.aggregates,
    orphanEvents: orphans.events,
    reclaimedMB: Math.round((reclaimed.freed * reclaimed.pageSize) / 1048576),
    ms: Date.now() - started,
  })
  return { pruned, orphans, freed: reclaimed.freed }
})

// A failing step is logged with its name and replaced by a neutral result, so it
// never skips the others; the next hourly pass retries it.
function step<A, E, R>(name: string, effect: Effect.Effect<A, E, R>, fallback: A) {
  return effect.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("database maintenance step failed", { step: name, cause: Cause.pretty(cause) }).pipe(
        Effect.as(fallback),
      ),
    ),
  )
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (Flag.OPENCODE_DISABLE_DB_MAINTENANCE) return
    const database = yield* Database.Service
    // A failed pass (e.g. SQLITE_BUSY after busy_timeout) is logged and the
    // next hourly pass retries; every step is safe to repeat.
    yield* Effect.suspend(() => pass(database.db, Date.now())).pipe(
      Effect.catchCause((cause) => Effect.logError("database maintenance failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )
  }),
)

export const node = makeGlobalNode({ name: "database-maintenance", layer, deps: [Database.node] })
