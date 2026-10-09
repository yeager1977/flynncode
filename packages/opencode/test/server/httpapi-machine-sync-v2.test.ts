import { describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { MachineSyncPaths } from "../../src/server/routes/instance/httpapi/machine-sync"
import { Session } from "@/session/session"
import { provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffect } from "../lib/effect"

// The whole server as server.ts builds it, so the sync store sees the same
// V2 SessionExecution that runs chats: no stand-in for the engine here.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

type Manifest = { sessions: Array<{ id: string; busy: boolean }> }

describe("machine sync on the mounted server", () => {
  it.live(
    "reports a chat busy while the V2 engine runs it and refuses to export it",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const release = Promise.withResolvers<void>()
        yield* llm.hold("done", release.promise)
        // Without `env` the provider needs no integration, so the V2 catalog
        // offers its model.
        const base = testProviderConfig(llm.url)
        const config = { ...base, provider: { test: { ...base.provider.test, env: undefined } } }
        const directory = yield* tmpdirScoped({ git: true, config })
        // The chat names the test model so the turn never reaches a real provider.
        const session = yield* Session.use
          .create({
            title: "v2 busy",
            model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
          })
          .pipe(provideInstanceEffect(directory))
        const busy = (manifest: Manifest) => manifest.sessions.find((item) => item.id === session.id)?.busy

        const prompted = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { "x-opencode-directory": directory, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompted.status).toBe(200)
        yield* llm.wait(1)

        const manifest = yield* request(MachineSyncPaths.manifest).pipe(Effect.flatMap((response) => response.json))
        expect(busy(manifest as Manifest)).toBe(true)
        expect((yield* request(`/flynncode-sync/session/${session.id}`)).status).toBe(409)

        release.resolve()
        yield* pollWithTimeout(
          request(MachineSyncPaths.manifest).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((body) => (busy(body as Manifest) === false ? true : undefined)),
          ),
          "the V2 turn never finished",
          "10 seconds",
        )
        expect((yield* request(`/flynncode-sync/session/${session.id}`)).status).toBe(200)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    30_000,
  )
})
