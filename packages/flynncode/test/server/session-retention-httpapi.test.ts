import { afterEach, describe, expect } from "bun:test"
import { rm } from "fs/promises"
import { inArray } from "drizzle-orm"
import { Effect, Fiber, Layer, Schema } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { locationServiceMapLayer } from "@flynncode/core/location-services"
import { SessionTable } from "@flynncode/core/session/sql"
import { SessionRetention as RetentionSchema } from "@flynncode/schema/session-retention"
import { SessionRetentionPaths } from "../../src/server/routes/instance/httpapi/groups/session-retention"
import { SessionRetention } from "../../src/session/retention/service"
import { Session } from "../../src/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"
import { route } from "./httpapi-exercise/dsl"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Built through the shared memoMap so the test and the served routes see the same database and services.
const it = testEffectShared(
  Layer.mergeAll(
    httpApiLayer,
    LayerNode.compile(LayerNode.group([Session.node, Database.node])),
    locationServiceMapLayer,
  ),
)

const DAY = 24 * 60 * 60 * 1000

afterEach(async () => {
  await rm(SessionRetention.defaultStatePath(), { force: true })
  await disposeAllInstances()
  await resetDatabase()
})

const decode =
  <S extends Schema.Top>(schema: S) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    HttpClientResponse.schemaBodyJson(schema)(response).pipe(Effect.orDie)

describe("session retention HttpApi", () => {
  it.instance("returns the period, the roots due within 3 days and a delayed first run", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const soon = yield* sessions.create({ title: "soon" })
      // Written just now: not due for 30 days.
      yield* sessions.create({ title: "fresh" })
      const latest = Date.now() - 28 * DAY
      yield* db
        .update(SessionTable)
        .set({ time_updated: latest })
        .where(inArray(SessionTable.id, [soon.id]))
        .run()
        .pipe(Effect.orDie)
      const firstRunAt = Date.now() + DAY
      yield* Effect.promise(() =>
        Bun.write(SessionRetention.defaultStatePath(), JSON.stringify({ firstRunAt, pendingFirstRunCount: 25 })),
      )

      const response = yield* requestInDirectory(SessionRetentionPaths.get, tmp.directory)

      expect(response.status).toBe(200)
      expect(yield* decode(RetentionSchema.Info)(response)).toEqual({
        cleanupPeriodDays: 30,
        firstRunAt,
        pendingFirstRunCount: 25,
        expiring: [{ sessionID: soon.id, deletesAt: latest + 30 * DAY }],
        kept: [],
      })
    }),
  )

  it.instance("keeps a root session merge-safely, announces it, and refuses sub-agents", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root", metadata: { worktree: "/somewhere", disposable: true } })
      const child = yield* sessions.create({ title: "child", parentID: root.id })
      const send = (sessionID: string, keep: boolean) =>
        requestInDirectory(route(SessionRetentionPaths.keep, { sessionID }), tmp.directory, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keep }),
        })

      const event = yield* waitGlobalBusEvent({
        predicate: (item) => item.payload.type === RetentionSchema.Event.Updated.type,
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const kept = yield* send(root.id, true)
      expect(kept.status).toBe(200)
      expect((yield* decode(Session.Info)(kept)).metadata).toEqual({
        worktree: "/somewhere",
        disposable: true,
        keep: true,
      })
      expect((yield* Fiber.join(event)).directory).toBe("global")

      const released = yield* send(root.id, false)
      expect((yield* decode(Session.Info)(released)).metadata).toEqual({ worktree: "/somewhere", disposable: true })
      expect((yield* sessions.get(root.id)).metadata).toEqual({ worktree: "/somewhere", disposable: true })

      expect((yield* send(child.id, true)).status).toBe(400)
      expect((yield* send("ses_retention_missing", true)).status).toBe(404)
    }),
  )
})
