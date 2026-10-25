import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Layer, Schedule } from "effect"
import { Storage } from "./storage"

export interface Interface {
  readonly sweep: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/SessionDiffSweep") {}

// session/revert.ts writes storage/session_diff/<sessionID>.json and nothing
// removes it when the session is deleted. Core's database maintenance cannot
// see this server-owned storage, so it gets its own hourly sweep.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    const sweep = Effect.fn("SessionDiffSweep.sweep")(function* () {
      const keys = yield* storage.list(["session_diff"]).pipe(Effect.orElseSucceed(() => []))
      if (keys.length === 0) return 0
      const live = new Set(
        (yield* database.db.all<{ id: string }>(sql`SELECT id FROM session`).pipe(Effect.orDie)).map((row) => row.id),
      )
      const stale = keys.filter((key) => !live.has(key.at(-1) ?? ""))
      yield* Effect.forEach(stale, (key) => storage.remove(key).pipe(Effect.ignore), { discard: true })
      if (stale.length > 0) yield* Effect.logInfo("session diff sweep", { removed: stale.length })
      return stale.length
    })
    yield* sweep().pipe(
      Effect.catchCause((cause) => Effect.logError("session diff sweep failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )
    return Service.of({ sweep })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Storage.node, Database.node] })

export * as SessionDiffSweep from "./session-diff-sweep"
