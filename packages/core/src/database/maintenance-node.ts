export * as DatabaseMaintenanceNode from "./maintenance-node"

import { Cause, Duration, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Flag } from "../flag/flag"
import { Database } from "./database"
import { DatabaseMaintenance } from "./maintenance"

type Db = Database.Interface["db"]

export const pass = Effect.fn("DatabaseMaintenance.pass")(function* (db: Db, now: number) {
  const started = Date.now()
  const pruned = yield* DatabaseMaintenance.pruneIdleSessions(db, { now })
  const orphans = yield* DatabaseMaintenance.sweepOrphans(db)
  const freed = yield* DatabaseMaintenance.reclaim(db)
  yield* Effect.logInfo("database maintenance pass", {
    sessions: pruned.sessions,
    events: pruned.events,
    orphanAggregates: orphans.aggregates,
    orphanEvents: orphans.events,
    reclaimedMB: Math.round((freed * 4096) / 1048576),
    ms: Date.now() - started,
  })
  return { pruned, orphans, freed }
})

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
