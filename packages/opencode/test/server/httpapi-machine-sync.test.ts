import { describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { rm, stat, utimes } from "node:fs/promises"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Config } from "@/config/config"
import { MachineSyncConfig } from "@/machine-sync/config-sync"
import { MachineSyncStore } from "@/machine-sync/store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { ServerAuth } from "@/server/auth"
import { authorizationRouterMiddleware } from "@/server/routes/instance/httpapi/middleware/authorization"
import { MachineSyncPaths, machineSyncRoutes } from "@/server/routes/instance/httpapi/machine-sync"
import { SessionID } from "@/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

// A session is "running" on the V2 engine while its id is in this set.
const executing = new Set<SessionID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(executing)),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

// The routes are served on the in-test server; the app graph is provided once
// so the routes and the test share one database. Each call builds its own graph.
const serve = (routes: typeof machineSyncRoutes) =>
  HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(
      AppNodeBuilder.build(
        LayerNode.group([MachineSyncStore.node, Database.node, Config.node, FSUtil.node, InstanceStore.node]),
        [
          [SessionExecution.node, execution],
          [InstanceStore.bootstrapNode, noopBootstrap],
        ],
      ),
    ),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  )
const it = testEffect(serve(machineSyncRoutes))
// Wired like server.ts: the raw routes sit behind the router authorization middleware.
const secretConfig = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "opencode" })
const itSecret = testEffect(
  serve(machineSyncRoutes.pipe(Layer.provide(authorizationRouterMiddleware.layer), Layer.provide(secretConfig))),
)

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

// The seeded chat's version as the sync worker reads it from the manifest.
const seeded = { timeUpdated: 10, timeArchived: null }

const basic = (password: string) => ({ authorization: ServerAuth.header({ username: "opencode", password }) ?? "" })

const exportBundle = (id: string, headers?: Record<string, string>) =>
  request(`/flynncode-sync/session/${id}`, { headers }).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as { session: Record<string, unknown>; parts: unknown[] }),
  )

describe("machine sync routes", () => {
  it.live("serves the manifest and session bundles", () =>
    Effect.gen(function* () {
      yield* seed("ses_route")
      const manifest = yield* request(MachineSyncPaths.manifest)
      expect(manifest.status).toBe(200)
      const body = (yield* manifest.json) as { sessions: Array<{ id: string }> }
      expect(body.sessions.map((session) => session.id)).toContain("ses_route")

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

      const exported = yield* exportBundle("ses_apply")
      expect((yield* request(MachineSyncPaths.apply, post({ bundle: exported }))).status).toBe(400)
      const applied = yield* request(
        MachineSyncPaths.apply,
        post({
          bundle: { ...exported, session: { ...exported.session, title: "from peer", time_updated: 50 } },
          expected: seeded,
        }),
      )
      expect(applied.status).toBe(200)
      const after = yield* exportBundle("ses_apply")
      expect(after.session).toMatchObject({ title: "from peer", time_updated: 50 })
    }),
  )

  it.live("deletes and archives through the local routes", () =>
    Effect.gen(function* () {
      yield* seed("ses_delete")
      yield* seed("ses_archive")
      expect(
        (yield* request("/flynncode-sync/delete/ses_delete", post({ timeDeleted: Date.now(), expected: seeded })))
          .status,
      ).toBe(200)
      expect(
        (yield* request("/flynncode-sync/archive/ses_archive", post({ timeArchived: 77, expected: seeded }))).status,
      ).toBe(200)
      expect((yield* request("/flynncode-sync/archive/ses_archive", post({}))).status).toBe(400)
      expect((yield* request("/flynncode-sync/archive/ses_archive", post({ timeArchived: 78 }))).status).toBe(400)

      const manifest = (yield* (yield* request(MachineSyncPaths.manifest)).json) as {
        sessions: Array<{ id: string; timeArchived: number | null }>
        tombstones: Array<{ id: string }>
      }
      expect(manifest.sessions).toContainEqual(expect.objectContaining({ id: "ses_archive", timeArchived: 77 }))
      expect(manifest.sessions.map((session) => session.id)).not.toContain("ses_delete")
      expect(manifest.tombstones.map((tombstone) => tombstone.id)).toContain("ses_delete")
    }),
  )

  it.live("rejects delete and archive requests with a bad id or timestamp", () =>
    Effect.gen(function* () {
      yield* seed("ses_badreq")
      expect((yield* request("/flynncode-sync/delete/not-a-session", post({ timeDeleted: 1 }))).status).toBe(400)
      expect((yield* request("/flynncode-sync/archive/not-a-session", post({ timeArchived: 1 }))).status).toBe(400)
      expect((yield* request("/flynncode-sync/delete/ses_badreq", post({}))).status).toBe(400)
      expect((yield* request("/flynncode-sync/delete/ses_badreq", post({ timeDeleted: 1.5 }))).status).toBe(400)
      expect((yield* request("/flynncode-sync/archive/ses_badreq", post({ timeArchived: "7" }))).status).toBe(400)
      expect((yield* request("/flynncode-sync/archive/ses_badreq", post({ timeArchived: 1.5 }))).status).toBe(400)
      expect((yield* request("/flynncode-sync/delete/ses_badreq", { method: "POST", body: "not json" })).status).toBe(
        400,
      )
    }),
  )

  it.live("answers 409 while the chat is running", () =>
    Effect.gen(function* () {
      yield* seed("ses_busy")
      const exported = yield* exportBundle("ses_busy")
      executing.add(SessionID.make("ses_busy"))
      yield* Effect.gen(function* () {
        expect((yield* request(MachineSyncPaths.apply, post({ bundle: exported, expected: seeded }))).status).toBe(409)
        expect(
          (yield* request("/flynncode-sync/delete/ses_busy", post({ timeDeleted: 5, expected: seeded }))).status,
        ).toBe(409)
        expect(
          (yield* request("/flynncode-sync/archive/ses_busy", post({ timeArchived: 5, expected: seeded }))).status,
        ).toBe(409)
        // A peer asking for the chat mid-turn is told to come back later.
        const bundle = yield* request("/flynncode-sync/session/ses_busy")
        expect(bundle.status).toBe(409)
        expect(yield* bundle.json).toEqual({ error: "busy" })
      }).pipe(Effect.ensuring(Effect.sync(() => executing.delete(SessionID.make("ses_busy")))))
      expect((yield* request("/flynncode-sync/session/ses_busy")).status).toBe(200)
      expect(
        (yield* request("/flynncode-sync/archive/ses_busy", post({ timeArchived: 5, expected: seeded }))).status,
      ).toBe(200)
    }),
  )

  it.live("answers 409 when the chat changed since the worker read the manifest", () =>
    Effect.gen(function* () {
      yield* seed("ses_stale")
      const exported = yield* exportBundle("ses_stale")
      const old = { timeUpdated: 9, timeArchived: null }
      const apply = yield* request(MachineSyncPaths.apply, post({ bundle: exported, expected: old }))
      expect(apply.status).toBe(409)
      expect(yield* apply.json).toEqual({ error: "stale" })
      expect((yield* request(MachineSyncPaths.apply, post({ bundle: exported, expected: null }))).status).toBe(409)
      expect((yield* request("/flynncode-sync/delete/ses_stale", post({ timeDeleted: 5, expected: old }))).status).toBe(
        409,
      )
      expect(
        (yield* request("/flynncode-sync/archive/ses_stale", post({ timeArchived: 5, expected: old }))).status,
      ).toBe(409)
      expect((yield* exportBundle("ses_stale")).session).toMatchObject({ time_archived: null })
    }),
  )

  it.live("answers 422 and keeps the chat when a bundle cannot be applied", () =>
    Effect.gen(function* () {
      yield* seed("ses_unapplied")
      const exported = yield* exportBundle("ses_unapplied")
      // Passes the shape check, but the part's message is not in the bundle, so
      // the foreign key fails during the insert.
      const orphan = {
        id: "prt_orphan",
        message_id: "msg_missing",
        session_id: "ses_unapplied",
        time_created: 1,
        time_updated: 1,
        data: { type: "text", text: "orphan" },
      }
      const response = yield* request(
        MachineSyncPaths.apply,
        post({
          bundle: {
            ...exported,
            session: { ...exported.session, title: "must not land", time_updated: 500 },
            parts: [orphan],
          },
          expected: seeded,
        }),
      )
      expect(response.status).toBe(422)
      expect(((yield* response.json) as { error: string }).error).toBeString()
      expect((yield* exportBundle("ses_unapplied")).session).toMatchObject({ title: "ses_unapplied", time_updated: 10 })
    }),
  )

  it.live("lists missing folders", () =>
    Effect.gen(function* () {
      yield* seed("ses_missing")
      const response = yield* request(MachineSyncPaths.missing)
      const body = (yield* response.json) as { directories: string[] }
      expect(body.directories).toContain("/nonexistent/flynncode-sync-route")
    }),
  )

  it.live("sends the global config without secrets and applies only a newer peer config", () =>
    Effect.gen(function* () {
      const file = Config.globalConfigFile()
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
      yield* Effect.promise(() =>
        Bun.write(
          file,
          `{\n  // keep me\n  "model": "local/model",\n  "provider": { "anthropic": { "options": { "apiKey": "sk-local" } } }\n}\n`,
        ),
      )
      yield* Effect.promise(() => utimes(file, new Date(1_000), new Date(1_000)))

      const sent = (yield* (yield* request(MachineSyncPaths.settings)).json) as {
        config: Record<string, unknown>
        mtime: number
      }
      expect(JSON.stringify(sent.config)).not.toContain("sk-local")
      expect(sent.mtime).toBe(1_000)

      const stale = yield* request(MachineSyncPaths.settingsApply, post({ config: { model: "peer/old" }, mtime: 500 }))
      expect(yield* stale.json).toEqual({ applied: false })

      const fresh = yield* request(
        MachineSyncPaths.settingsApply,
        post({
          config: {
            model: "peer/new",
            provider: { anthropic: { options: { apiKey: MachineSyncConfig.SECRET_PLACEHOLDER } } },
          },
          mtime: 2_000,
        }),
      )
      expect(yield* fresh.json).toEqual({ applied: true })
      const text = yield* Effect.promise(() => Bun.file(file).text())
      expect(text).toContain("// keep me")
      expect(text).toContain("peer/new")
      expect(text).toContain("sk-local")
      expect(text).not.toContain(MachineSyncConfig.SECRET_PLACEHOLDER)
      expect((yield* Effect.promise(() => stat(file))).mtimeMs).toBe(2_000)
    }),
  )

  it.live("reloads instances after a pulled config changed the file, but only once no chat runs", () =>
    Effect.gen(function* () {
      const file = Config.globalConfigFile()
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
      yield* Effect.promise(() => Bun.write(file, `{ "model": "local/model" }\n`))
      yield* Effect.promise(() => utimes(file, new Date(1_000), new Date(1_000)))
      const seen: string[] = []
      const listen = (event: GlobalEvent) => {
        if (event.directory === "global") seen.push(event.payload.type)
      }
      GlobalBus.on("event", listen)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listen)))

      executing.add(SessionID.make("ses_reload"))
      yield* Effect.gen(function* () {
        const applied = yield* request(
          MachineSyncPaths.settingsApply,
          post({ config: { model: "peer/new" }, mtime: 2_000 }),
        )
        expect(yield* applied.json).toEqual({ applied: true })
        // Settings views refresh right away; the reload would stop the running chat.
        expect(seen).toEqual(["config.updated"])
        yield* Effect.sleep("1500 millis")
        expect(seen).toEqual(["config.updated"])
      }).pipe(Effect.ensuring(Effect.sync(() => executing.delete(SessionID.make("ses_reload")))))
      yield* pollWithTimeout(
        Effect.sync(() => (seen.includes("global.disposed") ? true : undefined)),
        "instances were not reloaded once the chat went idle",
      )
      expect(seen).toEqual(["config.updated", "global.disposed"])

      // Newer but identical content only restamps the file: nothing to reload.
      seen.length = 0
      const same = yield* request(MachineSyncPaths.settingsApply, post({ config: { model: "peer/new" }, mtime: 3_000 }))
      expect(yield* same.json).toEqual({ applied: true })
      yield* Effect.sleep("1500 millis")
      expect(seen).toEqual([])
    }),
  )

  it.live("reports a peer config that fails validation without writing it", () =>
    Effect.gen(function* () {
      const file = Config.globalConfigFile()
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
      yield* Effect.promise(() => Bun.write(file, `{ "model": "local/model" }\n`))
      yield* Effect.promise(() => utimes(file, new Date(1_000), new Date(1_000)))
      const response = yield* request(MachineSyncPaths.settingsApply, post({ config: { model: 42 }, mtime: 2_000 }))
      expect(response.status).toBe(422)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toContain("local/model")
    }),
  )

  it.live("applies the rest of a peer config that deleted a secret-bearing MCP server, keeping it whole", () =>
    Effect.gen(function* () {
      const file = Config.globalConfigFile()
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
      yield* Effect.promise(() =>
        Bun.write(
          file,
          `{ "model": "local/model", "mcp": { "gh": { "type": "remote", "url": "https://mcp.example", "headers": { "Authorization": "Bearer local-gh" } } } }\n`,
        ),
      )
      yield* Effect.promise(() => utimes(file, new Date(1_000), new Date(1_000)))
      const response = yield* request(
        MachineSyncPaths.settingsApply,
        post({ config: { model: "peer/new" }, mtime: 2_000 }),
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ applied: true })
      const text = yield* Effect.promise(() => Bun.file(file).text())
      expect(text).toContain("peer/new")
      expect(text).toContain("Bearer local-gh")
      expect(text).toContain("https://mcp.example")
      expect(() => Config.validateText(text, file)).not.toThrow()
    }),
  )

  it.live("never echoes local config text or values in a 422", () =>
    Effect.gen(function* () {
      const file = Config.globalConfigFile()
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
      yield* Effect.promise(() =>
        Bun.write(file, `{ "model": "local/model", "provider": { "a": { "options": { "apiKey": "sk-leak-me" } } }\n`),
      )
      yield* Effect.promise(() => utimes(file, new Date(1_000), new Date(1_000)))
      // The local file does not parse: the parse error would embed the whole file.
      const broken = yield* request(
        MachineSyncPaths.settingsApply,
        post({ config: { model: "peer/new" }, mtime: 2_000 }),
      )
      expect(broken.status).toBe(422)
      const brokenBody = yield* broken.text
      expect(brokenBody).not.toContain("sk-leak-me")
      expect((JSON.parse(brokenBody) as { error: string }).error.length).toBeGreaterThan(0)

      // A schema failure reports field paths, never values.
      yield* Effect.promise(() =>
        Bun.write(file, `{ "model": "local/model", "provider": { "a": { "options": { "apiKey": "sk-leak-me" } } } }\n`),
      )
      yield* Effect.promise(() => utimes(file, new Date(1_000), new Date(1_000)))
      const invalid = yield* request(MachineSyncPaths.settingsApply, post({ config: { model: 42 }, mtime: 2_000 }))
      expect(invalid.status).toBe(422)
      const invalidBody = yield* invalid.text
      expect(invalidBody).not.toContain("sk-leak-me")
      expect(invalidBody).toContain("model")
    }),
  )

  it.live("answers an empty settings payload when there is no global config and rejects malformed applies", () =>
    Effect.gen(function* () {
      const file = Config.globalConfigFile()
      yield* Effect.promise(() => rm(file, { force: true }))
      expect(yield* (yield* request(MachineSyncPaths.settings)).json).toEqual({ config: null, mtime: 0, missing: true })
      yield* Effect.promise(() => Bun.write(file, `{ "model": `))
      expect(yield* (yield* request(MachineSyncPaths.settings)).json).toEqual({ config: null, mtime: 0 })
      yield* Effect.promise(() => rm(file, { force: true }))
      expect((yield* request(MachineSyncPaths.settingsApply, post({ config: [], mtime: 1 }))).status).toBe(400)
      expect((yield* request(MachineSyncPaths.settingsApply, post({ config: {}, mtime: "1" }))).status).toBe(400)
      expect((yield* request(MachineSyncPaths.settingsApply, { method: "POST", body: "nope" })).status).toBe(400)
    }),
  )
})

describe("machine sync routes behind the server password", () => {
  itSecret.live("refuses requests without the server credential", () =>
    Effect.gen(function* () {
      yield* seed("ses_auth")
      const exported = yield* exportBundle("ses_auth", basic("secret"))

      for (const headers of [undefined, basic("wrong")]) {
        const manifest = yield* request(MachineSyncPaths.manifest, { headers })
        expect(manifest.status).toBe(401)
        expect(manifest.headers["www-authenticate"] ?? "").toContain("Basic")
        const apply = yield* request(MachineSyncPaths.apply, {
          ...post({ bundle: exported, expected: seeded }),
          headers: { ...headers, "content-type": "application/json" },
        })
        expect(apply.status).toBe(401)
      }

      expect((yield* request(MachineSyncPaths.manifest, { headers: basic("secret") })).status).toBe(200)
      expect(
        (yield* request(MachineSyncPaths.apply, {
          ...post({ bundle: exported, expected: seeded }),
          headers: { ...basic("secret"), "content-type": "application/json" },
        })).status,
      ).toBe(200)
    }),
  )
})
