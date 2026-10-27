import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Config } from "../../src/config/config"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "opencode.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).exists())).toBe(false)
    }),
  )

  it.live(
    "serves the project-only config file",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false, username: "project-user" } })

      const response = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config/project", { headers: { "x-opencode-directory": tmp.path } })),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ username: "project-user", lsp: false })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )

  it.live(
    "lists Claude Code hook sources and switches one off in the global config",
    Effect.gen(function* () {
      const home = yield* tmpdirEffect({})
      const tmp = yield* tmpdirEffect({ git: true, config: { formatter: false, lsp: false } })
      const file = Config.globalConfigFile()
      const before = yield* Effect.promise(() =>
        Bun.file(file)
          .text()
          .catch(() => undefined),
      )
      const previousHome = process.env.OPENCODE_TEST_HOME
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
          else process.env.OPENCODE_TEST_HOME = previousHome
          if (before === undefined)
            await Bun.file(file)
              .delete()
              .catch(() => undefined)
          else await Bun.write(file, before)
        }),
      )
      process.env.OPENCODE_TEST_HOME = home.path
      const hooks = (command: string) => ({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
      })
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(home.path, ".claude", "settings.json"), JSON.stringify(hooks("user-check.sh"))),
          Bun.write(path.join(tmp.path, ".claude", "settings.json"), JSON.stringify(hooks("project-check.sh"))),
        ]),
      )
      const project = `claude:project:${path.join(tmp.path, ".claude")}`
      const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
      const list = () =>
        Effect.promise(async () => {
          const response = await app().request("/config/hooks/trust", { headers })
          expect(response.status).toBe(200)
          return response.json()
        })
      const toggle = (id: string, enabled: boolean) =>
        Effect.promise(() =>
          Promise.resolve(
            app().request("/config/hooks/claude", { method: "POST", headers, body: JSON.stringify({ id, enabled }) }),
          ),
        )

      const listed = yield* list()
      expect(listed.claudeDisabled).toBe(false)
      expect(listed.claudeSources).toEqual([
        expect.objectContaining({
          id: "claude:user",
          kind: "user",
          events: ["PreToolUse"],
          commands: ["user-check.sh"],
          enabled: true,
        }),
        expect.objectContaining({ id: project, kind: "project", commands: ["project-check.sh"], enabled: true }),
      ])
      expect(listed.hooks).toContainEqual(expect.objectContaining({ summary: "user-check.sh", source: "claude:user" }))

      const off = yield* toggle(project, false)
      expect(off.status).toBe(200)
      const offBody = yield* Effect.promise(() => off.json())
      expect(offBody.claudeSources).toContainEqual(expect.objectContaining({ id: project, enabled: false }))
      expect(offBody.hooks).not.toContainEqual(expect.objectContaining({ summary: "project-check.sh" }))
      expect(yield* Effect.promise(() => Bun.file(file).text())).toContain(project)
      expect((yield* list()).claudeSources).toContainEqual(expect.objectContaining({ id: project, enabled: false }))
      // Switched off globally, so the switch can turn it back on.
      expect((yield* list()).claudeSources).not.toContainEqual(
        expect.objectContaining({ id: project, disabledByProject: true }),
      )

      const on = yield* toggle(project, true)
      expect(on.status).toBe(200)
      expect((yield* Effect.promise(() => on.json())).claudeSources).toContainEqual(
        expect.objectContaining({ id: project, enabled: true }),
      )
      expect(yield* Effect.promise(() => Bun.file(file).text())).not.toContain(project)

      expect((yield* toggle("native:hook", false)).status).toBe(400)
    }),
  )

  it.live(
    "marks a Claude source disabled by project config",
    Effect.gen(function* () {
      const home = yield* tmpdirEffect({})
      const tmp = yield* tmpdirEffect({ git: true })
      const previousHome = process.env.OPENCODE_TEST_HOME
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
          else process.env.OPENCODE_TEST_HOME = previousHome
        }),
      )
      process.env.OPENCODE_TEST_HOME = home.path
      const project = `claude:project:${path.join(tmp.path, ".claude")}`
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(
            path.join(tmp.path, ".claude", "settings.json"),
            JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "project-check.sh" }] }] } }),
          ),
          Bun.write(
            path.join(tmp.path, "opencode.json"),
            JSON.stringify({ formatter: false, lsp: false, claude_hooks: { disabled: [project] } }),
          ),
        ]),
      )
      const response = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config/hooks/trust", { headers: { "x-opencode-directory": tmp.path } })),
      )
      expect(response.status).toBe(200)
      expect((yield* Effect.promise(() => response.json())).claudeSources).toContainEqual(
        expect.objectContaining({ id: project, enabled: false, disabledByProject: true }),
      )
    }),
  )
})
