import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

const runsFile = () => path.join(Global.Path.state, "routines-runs.jsonl")

const writeRuns = async (count: number) => {
  const records = Array.from({ length: count }, (_, n) => ({
    routineId: `routine-${n + 1}`,
    sessionID: `session-${n + 1}`,
    agent: "build",
    startedAt: new Date(2026, 8, 22, 9, n).toISOString(),
    endedAt: new Date(2026, 8, 22, 9, n, 30).toISOString(),
    state: "ok" as const,
  }))
  await Bun.write(runsFile(), records.map((row) => JSON.stringify(row)).join("\n") + "\n")
}

describe("global HttpApi", () => {
  it.live("returns recorded routine runs", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeRuns(3))
      const response = yield* HttpClientRequest.get(GlobalPaths.routinesRuns).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as { routineId: string }[]
      expect(body.map((row) => row.routineId)).toEqual(["routine-1", "routine-2", "routine-3"])
      yield* Effect.promise(() => fs.rm(runsFile(), { force: true }))
    }),
  )

  it.live("filters routine runs by routineId", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeRuns(3))
      const response = yield* HttpClientRequest.get(`${GlobalPaths.routinesRuns}?routineId=routine-2`).pipe(
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as { routineId: string }[]
      expect(body.map((row) => row.routineId)).toEqual(["routine-2"])
      yield* Effect.promise(() => fs.rm(runsFile(), { force: true }))
    }),
  )

  it.live("returns an empty list when no runs file exists", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.rm(runsFile(), { force: true }))
      const response = yield* HttpClientRequest.get(GlobalPaths.routinesRuns).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual([])
    }),
  )

  it.live("returns an empty list for an empty runs file", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => Bun.write(runsFile(), ""))
      const response = yield* HttpClientRequest.get(GlobalPaths.routinesRuns).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual([])
    }),
  )

  it.live("upgrades to the requested version", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "9.9.9" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects invalid upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: 1 }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects invalid upgrade target versions", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "latest" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects unsupported upgrade content types", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text('{"target":"1.0.0"}', "text/plain")),
        HttpClient.execute,
      )

      expect(response.status).toBe(415)
    }),
  )
})
