import { describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { MachineSyncStore } from "@/machine-sync/store"
import { MachineSyncPaths, machineSyncRoutes } from "@/server/routes/instance/httpapi/machine-sync"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// The routes are served alone (no auth layer) on the in-test server; the app
// graph is provided once so the routes and the test share one database.
// No chat runs in these tests, so the engine is an idle stand-in.
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)
const appLayer = AppNodeBuilder.build(LayerNode.group([MachineSyncStore.node, Database.node]), [
  [SessionExecution.node, execution],
])
const served = HttpRouter.serve(machineSyncRoutes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(appLayer),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(served)

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const seed = Effect.fn("test.machineSyncRoutes.seed")(function* (id: string) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: SessionID.make(id),
      project_id: ProjectV2.ID.global,
      slug: id,
      directory: "/nonexistent/flynncode-sync-route",
      title: id,
      version: "test",
      time_created: 1,
      time_updated: 10,
    })
    .run()
})

describe("machine sync routes", () => {
  it.live("serves the manifest and session bundles", () =>
    Effect.gen(function* () {
      yield* seed("ses_route")
      const manifest = yield* request(MachineSyncPaths.manifest)
      expect(manifest.status).toBe(200)
      const body = (yield* manifest.json) as { sessions: Array<{ id: string }> }
      expect(body.sessions.map((session) => session.id)).toEqual(["ses_route"])

      const bundle = yield* request("/flynncode-sync/session/ses_route")
      expect(bundle.status).toBe(200)
      expect(((yield* bundle.json) as { session: { title: string } }).session.title).toBe("ses_route")
      expect((yield* request("/flynncode-sync/session/ses_unknown")).status).toBe(404)
      expect((yield* request("/flynncode-sync/session/not-a-session")).status).toBe(404)
    }),
  )

  it.live("rejects malformed bundles and applies valid ones", () =>
    Effect.gen(function* () {
      yield* seed("ses_apply")
      expect((yield* request(MachineSyncPaths.apply, post({ version: 1 }))).status).toBe(400)

      const exported = (yield* (yield* request("/flynncode-sync/session/ses_apply")).json) as {
        session: Record<string, unknown>
      }
      const applied = yield* request(
        MachineSyncPaths.apply,
        post({ ...exported, session: { ...exported.session, title: "from peer", time_updated: 50 } }),
      )
      expect(applied.status).toBe(200)
      const after = (yield* (yield* request("/flynncode-sync/session/ses_apply")).json) as {
        session: { title: string; time_updated: number }
      }
      expect(after.session).toMatchObject({ title: "from peer", time_updated: 50 })
    }),
  )

  it.live("deletes and archives through the local routes", () =>
    Effect.gen(function* () {
      yield* seed("ses_delete")
      yield* seed("ses_archive")
      expect((yield* request("/flynncode-sync/delete/ses_delete", post({ timeDeleted: Date.now() }))).status).toBe(200)
      expect((yield* request("/flynncode-sync/archive/ses_archive", post({ timeArchived: 77 }))).status).toBe(200)
      expect((yield* request("/flynncode-sync/archive/ses_archive", post({}))).status).toBe(400)

      const manifest = (yield* (yield* request(MachineSyncPaths.manifest)).json) as {
        sessions: Array<{ id: string; timeArchived: number | null }>
        tombstones: Array<{ id: string }>
      }
      expect(manifest.sessions).toEqual([expect.objectContaining({ id: "ses_archive", timeArchived: 77 })])
      expect(manifest.tombstones.map((tombstone) => tombstone.id)).toEqual(["ses_delete"])
    }),
  )

  it.live("lists missing folders", () =>
    Effect.gen(function* () {
      yield* seed("ses_missing")
      const response = yield* request(MachineSyncPaths.missing)
      expect(yield* response.json).toEqual({ directories: ["/nonexistent/flynncode-sync-route"] })
    }),
  )
})
