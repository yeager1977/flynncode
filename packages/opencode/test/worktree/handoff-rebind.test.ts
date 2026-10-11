import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session as SessionNs } from "@/session/session"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Worktree } from "../../src/worktree"
import { shouldDispose } from "../../src/worktree/session-binding"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

// HTTP-level fixture: the served instance route tree plus the shared Session
// and Database nodes, mirroring test/server/httpapi-experimental.test.ts.
// Handoff tests create git worktrees through the endpoint and must remove
// them before the test settles: a leftover worktree keeps the run alive.
const itHttp = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([SessionNs.node, Database.node])), httpApiLayer),
)

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

describe("handoff rebind", () => {
  it.instance("rebinds the session directory to the handoff target", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "handoff-rebind" })
      const target = `${created.directory}-handoff-target`

      yield* session.setDirectory({ sessionID: created.id, directory: target })

      expect((yield* session.get(created.id)).directory).toBe(target)
    }),
  )

  test("source disposable worktree is eligible for disposal after handoff completes", () => {
    const binding = { sessionID: "ses_1", directory: "/w/old", disposable: true }
    expect(shouldDispose(binding, { archived: false, running: false })).toBe(false)
    expect(shouldDispose({ ...binding }, { archived: true, running: false })).toBe(true)
  })
})

describe("handoff rebind over HttpApi", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  // Creates the worktree through the endpoint and removes it on release.
  const withWorktree = (
    directory: string,
    name: string,
    use: (info: Worktree.Info) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
  ) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const created = yield* request(ExperimentalPaths.worktree, directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        })
        expect(created.status).toBe(200)
        return yield* json<Worktree.Info>(created)
      }),
      use,
      (info) =>
        request(ExperimentalPaths.worktree, directory, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: info.directory }),
        }).pipe(Effect.asVoid, Effect.catch(() => Effect.void)),
    )

  const postHandoff = (directory: string, from: string, to: string) =>
    request(ExperimentalPaths.worktreeHandoff, directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    })

  itHttp.instance(
    "rebinds sessions off the primary when allow_primary_rebind is set",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* SessionNs.Service
        const dir = test.directory

        yield* withWorktree(dir, "rebind-target", (info) =>
          Effect.gen(function* () {
            const created = yield* sessions.create({ title: "local-bound" })
            yield* sessions.setDirectory({ sessionID: created.id, directory: dir })

            const handoff = yield* postHandoff(dir, dir, info.directory)
            expect(handoff.status).toBe(200)
            expect(yield* json<boolean>(handoff)).toBe(true)

            // The session row followed the handoff off the primary checkout.
            const rebound = yield* sessions.listGlobal({ directory: dir, archived: true, limit: 1 })
            expect(rebound.length).toBe(0)
            expect((yield* sessions.get(created.id)).directory).toBe(info.directory)
          }),
        )
      }),
    { git: true, config: { formatter: false, lsp: false, worktree: { allow_primary_rebind: true } } },
  )

  itHttp.instance(
    "keeps sessions on the primary when the rebind flag is off (default)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* SessionNs.Service
        const dir = test.directory

        yield* withWorktree(dir, "rebind-refused", (info) =>
          Effect.gen(function* () {
            const created = yield* sessions.create({ title: "local-bound" })
            yield* sessions.setDirectory({ sessionID: created.id, directory: dir })

            const handoff = yield* postHandoff(dir, dir, info.directory)
            expect(handoff.status).toBe(200)
            expect(yield* json<boolean>(handoff)).toBe(true)

            const remaining = yield* sessions.listGlobal({ directory: dir, archived: true, limit: 10 })
            expect(remaining.length).toBe(1)
            expect((yield* sessions.get(created.id)).directory).toBe(dir)
          }),
        )
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  itHttp.instance(
    "still refuses to rebind away from the serving worktree instance with the flag set",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* SessionNs.Service
        const dir = test.directory

        yield* withWorktree(dir, "rebind-source", (source) =>
          withWorktree(dir, "rebind-self", (target) =>
            Effect.gen(function* () {
              const created = yield* sessions.create({ title: "worktree-bound" })
              yield* sessions.setDirectory({ sessionID: created.id, directory: source.directory })

              const handoff = yield* postHandoff(source.directory, source.directory, target.directory)
              expect(handoff.status).toBe(200)

              // The serving-instance guard stays fatal even with the flag on.
              expect((yield* sessions.get(created.id)).directory).toBe(source.directory)
            }),
          ),
        )
      }),
    { git: true, config: { formatter: false, lsp: false, worktree: { allow_primary_rebind: true } } },
  )
})