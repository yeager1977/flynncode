import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Database } from "@flynncode/core/database/database"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { MoveSession } from "@flynncode/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { Project } from "../../src/project/project"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { WorktreeCleanupPaths } from "../../src/server/routes/instance/httpapi/groups/worktree-cleanup"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { worktreeCleanupHandlers } from "../../src/server/routes/instance/httpapi/handlers/worktree-cleanup"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { WorktreeJanitor } from "../../src/worktree/janitor/janitor"
import { testEffect } from "../lib/effect"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, worktreeCleanupHandlers]),
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
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(
    AppNodeBuilder.build(LayerNode.group([WorktreeJanitor.node, Project.node, Database.node, CrossSpawnSpawner.node])),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("worktree cleanup HttpApi", () => {
  it.live("reports an empty review list before any scan", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(WorktreeCleanupPaths.report).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ items: [], cleaned: [], scanning: false })
    }),
  )

  it.live("scan returns a report", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(WorktreeCleanupPaths.scan).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as { items: unknown[]; cleaned: unknown[]; scanning: boolean }
      expect(Array.isArray(body.items)).toBe(true)
      expect(Array.isArray(body.cleaned)).toBe(true)
      expect(body.scanning).toBe(false)
    }),
  )

  it.live("refuses to remove a path that is not on the review list", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(WorktreeCleanupPaths.remove).pipe(
        HttpClientRequest.bodyJsonUnsafe({ paths: ["/etc"] }),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        results: [expect.objectContaining({ path: "/etc", ok: false, error: expect.any(String) })],
      })
    }),
  )

  it.live("rejects a remove body without paths", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(WorktreeCleanupPaths.remove).pipe(
        HttpClientRequest.bodyJsonUnsafe({}),
        HttpClient.execute,
      )
      expect(response.status).toBe(400)
    }),
  )
})
