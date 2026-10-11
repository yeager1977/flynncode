import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Flag } from "@flynncode/core/flag/flag"
import { Ripgrep } from "@flynncode/core/ripgrep"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { containsPath } from "../../src/project/instance-context"
import { Project } from "../../src/project/project"
import { Session } from "@/session/session"
import { Workspace } from "../../src/control-plane/workspace"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { ProjectDirectories } from "@flynncode/core/project/directories"
import { AbsolutePath } from "@flynncode/core/schema"
import { Database } from "@flynncode/core/database/database"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    Ripgrep.node,
    ProjectDirectories.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

function postFolders(sessionID: string, directory: string, body: unknown) {
  return request(pathFor(SessionPaths.folders, { sessionID }), {
    method: "POST",
    headers: { "x-opencode-directory": directory, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session folders HttpApi", () => {
  it.instance(
    "rejects missing extra paths without creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const missing = path.join(test.directory, "no-such-folder")
        const before = yield* Session.use.list()

        const exit = yield* Session.use
          .create({ title: "missing-extra", additionalDirectories: [missing] })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "SessionMultifoldError",
            reason: "missing",
            path: missing,
          })
        }
        expect((yield* Session.use.list()).length).toBe(before.length)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects more than 8 extras",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const extras = yield* Effect.forEach(
          Array.from({ length: 9 }, (_, index) => path.join(test.directory, `extra-${index}`)),
          (dir) => Effect.promise(() => fs.mkdir(dir, { recursive: true })).pipe(Effect.as(dir)),
        )
        const before = yield* Session.use.list()

        const exit = yield* Session.use
          .create({ title: "too-many-extras", additionalDirectories: extras })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionMultifoldError", reason: "limit" })
        }
        expect((yield* Session.use.list()).length).toBe(before.length)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "filters duplicate and primary entries on create",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const extra = path.join(test.directory, "docs")
        yield* Effect.promise(() => fs.mkdir(extra, { recursive: true }))
        const headers = { "x-opencode-directory": test.directory }

        const session = yield* Session.use.create({
          title: "deduped-extras",
          additionalDirectories: [extra, test.directory, extra],
        })
        expect((yield* Session.use.get(session.id)).directory).toBe(test.directory)

        const folders = yield* requestJson<{ primary: string; extras: string[] }>(
          pathFor(SessionPaths.folders, { sessionID: session.id }),
          { headers },
        )
        expect(folders).toEqual({ primary: test.directory, extras: [extra] })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "same-primary update does not reboot the instance",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const store = yield* InstanceStore.Service
        const session = yield* Session.use.create({ title: "same-primary" })

        const before = yield* store.load({ directory: test.directory })
        const response = yield* postFolders(session.id, test.directory, { primary: test.directory })
        expect(response.status).toBe(200)
        const after = yield* store.load({ directory: test.directory })
        expect(after).toBe(before)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "primary switch rebinds the session and demotes the old primary",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const next = path.join(test.directory, "packages", "app")
        yield* Effect.promise(() => fs.mkdir(next, { recursive: true }))
        const session = yield* Session.use.create({ title: "switch-primary" })

        const response = yield* postFolders(session.id, test.directory, { primary: next })
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({ primary: next, extras: [test.directory] })
        expect((yield* Session.use.get(session.id)).directory).toBe(next)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "combined primary and extras uses provided extras verbatim",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const next = path.join(test.directory, "packages", "app")
        const third = path.join(test.directory, "packages", "core")
        yield* Effect.promise(() => fs.mkdir(next, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(third, { recursive: true }))
        const session = yield* Session.use.create({ title: "combined-folders" })

        const response = yield* postFolders(session.id, test.directory, { primary: next, extras: [third] })
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({ primary: next, extras: [third] })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects cross-project primary switch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const other = yield* tmpdirScoped({ git: true })
        const session = yield* Session.use.create({ title: "cross-project" })

        const response = yield* postFolders(session.id, test.directory, { primary: other })
        expect(response.status).toBe(400)
        expect(yield* response.json).toMatchObject({ message: expect.stringContaining("same project") })
        expect((yield* Session.use.get(session.id)).directory).toBe(test.directory)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "deny-after-remove closes the live boundary for detached extras",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const extra = yield* tmpdirScoped()
        const secret = path.join(extra, "secret.txt")
        yield* Effect.promise(() => fs.writeFile(secret, "top-secret"))
        const store = yield* InstanceStore.Service
        const session = yield* Session.use.create({ title: "deny-after-remove" })

        const attach = yield* postFolders(session.id, test.directory, { extras: [extra] })
        expect(attach.status).toBe(200)
        const attachedCtx = yield* store.load({ directory: test.directory })
        expect(attachedCtx.additionalDirectories).toEqual([extra])
        expect(containsPath(secret, attachedCtx)).toBe(true)

        const detach = yield* postFolders(session.id, test.directory, { extras: [] })
        expect(detach.status).toBe(200)
        expect(yield* detach.json).toEqual({ primary: test.directory, extras: [] })
        const detachedCtx = yield* store.load({ directory: test.directory })
        expect(detachedCtx).toBe(attachedCtx)
        expect(detachedCtx.additionalDirectories).toEqual([])
        expect(containsPath(secret, detachedCtx)).toBe(false)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
  it.instance(
    "v2 folders route widens the running instance boundary",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const extra = yield* tmpdirScoped()
        const store = yield* InstanceStore.Service
        const session = yield* Session.use.create({ title: "v2-attach" })
        const ctx = yield* store.load({ directory: test.directory })

        const attach = yield* request(`/api/session/${session.id}/folders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ extras: [extra] }),
        })
        expect(attach.status).toBe(200)
        expect(ctx.additionalDirectories).toEqual([extra])

        const detach = yield* request(`/api/session/${session.id}/folders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ extras: [] }),
        })
        expect(detach.status).toBe(200)
        expect(ctx.additionalDirectories).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "extras stay per session and never touch project directory rows",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const extra = yield* tmpdirScoped()
        const sandbox = yield* tmpdirScoped()
        const directories = yield* ProjectDirectories.Service
        const first = yield* Session.use.create({ title: "first" })
        const second = yield* Session.use.create({ title: "second" })
        const projectID = (yield* Session.use.get(first.id)).projectID
        yield* directories.create({ projectID, directory: AbsolutePath.make(sandbox) })

        expect((yield* postFolders(first.id, test.directory, { extras: [extra] })).status).toBe(200)
        const own = yield* requestJson<{ extras: string[] }>(pathFor(SessionPaths.folders, { sessionID: first.id }), {
          headers,
        })
        expect(own.extras).toEqual([extra])
        const other = yield* requestJson<{ extras: string[] }>(
          pathFor(SessionPaths.folders, { sessionID: second.id }),
          { headers },
        )
        expect(other.extras).toEqual([])

        expect((yield* postFolders(first.id, test.directory, { extras: [] })).status).toBe(200)
        expect(yield* directories.contains({ projectID, directory: AbsolutePath.make(sandbox) })).toBe(true)
        expect(yield* directories.contains({ projectID, directory: AbsolutePath.make(extra) })).toBe(false)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "reads file content under an attached folder",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const extra = yield* tmpdirScoped()
        yield* Effect.promise(() => fs.writeFile(path.join(extra, "notes.txt"), "attached"))
        const session = yield* Session.use.create({ title: "attached-read" })
        expect((yield* postFolders(session.id, test.directory, { extras: [extra] })).status).toBe(200)

        const result = yield* requestJson<{ type: string; content: string }>(
          `${FilePaths.content}?path=${encodeURIComponent(path.join(extra, "notes.txt"))}`,
          { headers: { "x-opencode-directory": test.directory } },
        )
        expect(result).toMatchObject({ type: "text", content: "attached" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "file list lists attached extras and stays inside the boundary union",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const extra = yield* tmpdirScoped()
        yield* Effect.promise(() => fs.writeFile(path.join(extra, "notes.txt"), "attached"))
        const session = yield* Session.use.create({ title: "list-extras" })
        expect((yield* postFolders(session.id, test.directory, { extras: [extra] })).status).toBe(200)
        const headers = { "x-opencode-directory": test.directory }

        const root = yield* requestJson<{ name: string; path: string; absolute: string; type: string; ignored: boolean }[]>(
          `${FilePaths.list}?path=.`,
          { headers },
        )
        expect(root).toContainEqual({
          name: path.basename(extra),
          path: extra,
          absolute: extra,
          type: "directory",
          ignored: false,
        })

        const inside = yield* requestJson<{ name: string; path: string; absolute: string; type: string; ignored: boolean }[]>(
          `${FilePaths.list}?path=${encodeURIComponent(extra)}`,
          { headers },
        )
        expect(inside).toContainEqual({
          name: "notes.txt",
          path: path.join(extra, "notes.txt"),
          absolute: path.join(extra, "notes.txt"),
          type: "file",
          ignored: expect.anything(),
        })

        const stray = yield* tmpdirScoped()
        yield* Effect.promise(() => fs.writeFile(path.join(stray, "hidden.txt"), "hidden"))
        const outside = yield* request(`${FilePaths.list}?path=${encodeURIComponent(stray)}`, { headers })
        expect(outside.status).toBe(500)

        const search = yield* pollWithTimeout(
          Effect.gen(function* () {
            const response = yield* requestJson<string[]>(`${FilePaths.findFile}?query=notes&type=file`, {
              headers,
            })
            return response.some((item) => item === path.join(extra, "notes.txt")) ? response : undefined
          }),
          "extra folder search never returned notes.txt",
        )
        expect(search).toContain(path.join(extra, "notes.txt"))
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
