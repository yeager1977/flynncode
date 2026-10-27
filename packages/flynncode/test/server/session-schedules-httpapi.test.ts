import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { locationServiceMapLayer } from "@flynncode/core/location-services"
import { SessionSchedule } from "@flynncode/schema/session-schedule"
import { SessionSchedulesPaths } from "../../src/server/routes/instance/httpapi/groups/session-schedules"
import { ScheduleStore } from "../../src/schedule/store"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"
import { route } from "./httpapi-exercise/dsl"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Built through the shared memoMap so the test and the served routes see the same ScheduleStore.
const it = testEffectShared(
  Layer.mergeAll(
    httpApiLayer,
    LayerNode.compile(LayerNode.group([ScheduleStore.node, Session.node])),
    locationServiceMapLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const now = new Date("2026-10-27T10:00:30")

const decode =
  <S extends Schema.Top>(schema: S) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    HttpClientResponse.schemaBodyJson(schema)(response).pipe(Effect.orDie)

describe("session schedules HttpApi", () => {
  it.instance("lists only the public fields of the session's jobs, soonest first", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const store = yield* ScheduleStore.Service
      const sessionID = SessionID.make("ses_schedules_list")
      const cron = yield* store.create({
        sessionID,
        kind: "cron",
        cron: "*/5 * * * *",
        prompt: "check the build",
        recurring: true,
        now,
      })
      const wakeup = yield* store.create({
        sessionID,
        kind: "wakeup",
        prompt: "look again",
        reason: "waiting for CI",
        recurring: false,
        runAt: new Date(now.getTime() + 60_000),
        now,
      })
      yield* store.create({
        sessionID: SessionID.make("ses_schedules_other"),
        kind: "cron",
        cron: "0 * * * *",
        prompt: "someone else's",
        recurring: true,
        now,
      })

      const response = yield* requestInDirectory(route(SessionSchedulesPaths.list, { sessionID }), tmp.directory)
      expect(response.status).toBe(200)
      const body = yield* decode(Schema.Array(SessionSchedule.Info))(response)
      expect(body).toEqual([
        {
          id: wakeup.id,
          kind: "wakeup",
          prompt: "look again",
          reason: "waiting for CI",
          recurring: false,
          nextRunAt: now.getTime() + 60_000,
        },
        {
          id: cron.id,
          kind: "cron",
          cron: "*/5 * * * *",
          prompt: "check the build",
          recurring: true,
          nextRunAt: new Date("2026-10-27T10:05:00").getTime(),
          expiresAt: cron.expires_at ?? undefined,
        },
      ])
      expect(cron.expires_at).toBeNumber()
      const raw = (yield* response.json) as ReadonlyArray<Record<string, unknown>>
      expect(Object.keys(raw[0]).sort()).toEqual(["id", "kind", "nextRunAt", "prompt", "reason", "recurring"])
      expect(Object.keys(raw[1]).sort()).toEqual([
        "cron",
        "expiresAt",
        "id",
        "kind",
        "nextRunAt",
        "prompt",
        "recurring",
      ])

      const empty = yield* requestInDirectory(
        route(SessionSchedulesPaths.list, { sessionID: "ses_schedules_none" }),
        tmp.directory,
      )
      expect(yield* decode(Schema.Array(SessionSchedule.Info))(empty)).toEqual([])
    }),
  )

  it.instance("delete cancels the session's job, announces it and answers 404 otherwise", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const store = yield* ScheduleStore.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Schedules owner" })
      const job = yield* store.create({
        sessionID: session.id,
        kind: "cron",
        cron: "*/5 * * * *",
        prompt: "check the build",
        recurring: true,
        now,
      })
      const foreign = yield* store.create({
        sessionID: SessionID.make("ses_schedules_foreign"),
        kind: "cron",
        cron: "0 * * * *",
        prompt: "not yours",
        recurring: true,
        now,
      })
      const send = (sessionID: string, jobID: string) =>
        requestInDirectory(route(SessionSchedulesPaths.delete, { sessionID, jobID }), tmp.directory, {
          method: "DELETE",
        })

      expect((yield* send(session.id, "sch_missing")).status).toBe(404)
      // A job of another session is not reachable through this session's route.
      expect((yield* send(session.id, foreign.id)).status).toBe(404)
      expect(yield* store.list(SessionID.make("ses_schedules_foreign"))).toHaveLength(1)

      const event = yield* waitGlobalBusEvent({
        predicate: (item) => item.payload.type === SessionSchedule.Event.Updated.type,
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const response = yield* send(session.id, job.id)
      expect(response.status).toBe(200)
      expect(yield* decode(Schema.Boolean)(response)).toBe(true)
      expect(yield* store.list(session.id)).toEqual([])
      expect((yield* Fiber.join(event)).payload.properties).toEqual({ sessionID: session.id })
      expect((yield* send(session.id, job.id)).status).toBe(404)
    }),
  )
})
