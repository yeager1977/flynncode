import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { PreviewPaths } from "../../src/server/routes/instance/httpapi/groups/preview"
import { Preview } from "../../src/preview/preview"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Preview.node, Database.node])), httpApiLayer))

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("preview HttpApi", () => {
  it.instance(
    "lists configured preview servers",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* request(PreviewPaths.servers, tmp.directory)
        expect(response.status).toBe(200)
        const servers = yield* (response.json as Effect.Effect<unknown, never, never>) as Effect.Effect<
          Array<{ name: string; state: string; url?: string; attach?: boolean }>,
          never,
          never
        >
        expect(servers).toEqual([{ name: "attached", state: "stopped", url: "http://localhost:4519/", attach: true }])
      }),
    {
      config: { preview: { servers: [{ name: "attached", url: "http://localhost:4519" }] } } as never,
    },
  )

  it.instance(
    "start/stop/restart an attach-only server through the endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        for (const action of ["start", "restart", "stop"] as const) {
          const response = yield* request(`${PreviewPaths[action === "start" ? "start" : action === "stop" ? "stop" : "restart"]}`, tmp.directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "attached" }),
          })
          expect(response.status).toBe(200)
          const server = (yield* (response.json as Effect.Effect<unknown, never, never>)) as { name: string; state: string }
          expect(server.name).toBe("attached")
        }
        const after = yield* request(PreviewPaths.servers, tmp.directory)
        const list = (yield* (after.json as Effect.Effect<unknown, never, never>)) as Array<{ state: string }>
        expect(list[0].state).toBe("stopped")
      }),
    {
      config: { preview: { servers: [{ name: "attached", url: "http://localhost:4519/" }] } } as never,
    },
  )

  it.instance(
    "start returns a declared error for an unknown server",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* request(PreviewPaths.start, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "nope" }),
        })
        expect(response.status).toBe(400)
        const body = (yield* (response.json as Effect.Effect<unknown, never, never>)) as { name: string; data: { message: string } }
        expect(body.name).toBe("PreviewUnknownServerError")
        expect(body.data.message).toContain("No preview server named")
      }),
    {
      config: { preview: { servers: [] } } as never,
    },
  )

  it.instance(
    "verify returns the declared error when nothing is running",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* request(PreviewPaths.verify, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(response.status).toBe(400)
        const body = (yield* (response.json as Effect.Effect<unknown, never, never>)) as { name: string }
        expect(body.name).toBe("PreviewNoRunningServerError")
      }),
    {
      config: { preview: { servers: [] } } as never,
    },
  )
})