import { afterEach, describe, expect, spyOn } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Duration, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { FSUtil } from "@flynncode/core/fs-util"
import { Agent } from "../../src/agent/agent"
import { LSP } from "@/lsp/lsp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as LSPServer from "@/lsp/server"
import { LSPLaunch } from "@/lsp/launch"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { LspTool } from "../../src/tool/lsp"
import { Global } from "@flynncode/core/global"
import { InstanceState } from "@/effect/instance-state"
import { disposeAllInstancesEffect, provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

// Downloads stay off so an unexpected builtin match can never fetch a real server.
const it = testEffect(
  LayerNode.compile(LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Truncate.node, LSP.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ disableLspDownload: true })],
  ]),
)

// Only used with a mocked spawn: proves lazy mode overrides the download flag itself.
const downloadsAllowed = testEffect(
  LayerNode.compile(LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Truncate.node, LSP.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ disableLspDownload: false })],
  ]),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const spies: { mockRestore: () => void }[] = []

afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore())
})

const definition = Effect.fn("LspLazyTest.definition")(function* (file: string) {
  const info = yield* LspTool
  const tool = yield* info.init()
  return yield* tool.execute({ operation: "goToDefinition", filePath: file, line: 1, character: 1 }, ctx)
})

const write = (file: string) => Effect.promise(() => Bun.write(file, "pub fn main() { 1 }\n"))

// A builtin server whose spawn runs the fake server instead of the real binary.
const fakeBuiltin = (server: LSPServer.Info, pidFile: string) => {
  const spy = spyOn(server, "spawn").mockImplementation(async (root) => ({
    process: LSPLaunch.spawn(process.execPath, [fakeServerPath], {
      cwd: root,
      env: { ...process.env, FAKE_LSP_PID_FILE: pidFile, FAKE_LSP_CHILD: "1", FAKE_LSP_PUBLISH: "1" },
    }),
  }))
  spies.push(spy)
  return spy
}

// Custom servers start in the instance directory, so a relative pid file lands there.
const fakeEntry = (name: string) => ({
  command: [process.execPath, fakeServerPath],
  extensions: [`.fake${name}`],
  env: { FAKE_LSP_PID_FILE: `${name}.pid`, FAKE_LSP_PUBLISH: "1" },
})

const fakeConfig = (...names: string[]) => ({ lsp: Object.fromEntries(names.map((name) => [name, fakeEntry(name)])) })

const readPid = (file: string) =>
  Effect.promise(async () => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const text = await fs.readFile(file, "utf8").catch(() => "")
      if (text) return Number(text)
      await Bun.sleep(20)
    }
    throw new Error(`pid file never appeared: ${file}`)
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const gone = (pid: number) =>
  Effect.promise(async () => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (!alive(pid)) return true
      await Bun.sleep(20)
    }
    return false
  })

describe("lsp lazy mode (lsp key absent)", () => {
  it.instance("read/edit warm-ups do not spawn, the lsp tool does, and dispose leaves no orphans", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const pidFile = path.join(dir, "gleam.pid")
      const spawn = fakeBuiltin(LSPServer.Gleam, pidFile)
      const lsp = yield* LSP.Service
      const file = path.join(dir, "main.gleam")
      yield* write(file)

      yield* lsp.touchFile(file, "document")
      yield* lsp.touchFile(file)
      expect(spawn).toHaveBeenCalledTimes(0)
      expect(yield* lsp.status()).toEqual([])

      const result = yield* definition(file)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(result.output).toContain("main.gleam")
      expect((yield* lsp.status()).map((item) => item.id)).toEqual(["gleam"])

      // Once running, warm-ups reuse the client instead of spawning another.
      yield* lsp.touchFile(file, "document")
      expect(spawn).toHaveBeenCalledTimes(1)

      const pid = yield* readPid(pidFile)
      const child = yield* readPid(pidFile + ".child")
      expect(alive(pid)).toBe(true)
      expect(alive(child)).toBe(true)

      yield* disposeAllInstancesEffect
      expect(yield* gone(pid)).toBe(true)
      expect(yield* gone(child)).toBe(true)
    }),
  )

  it.instance("missing server binary yields a tool message without retrying the spawn", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const spawn = spyOn(LSPServer.Gleam, "spawn").mockResolvedValue(undefined)
      spies.push(spawn)
      const file = path.join(dir, "main.gleam")
      yield* write(file)

      expect((yield* definition(file)).output).toBe("no language server for .gleam")
      expect((yield* definition(file)).output).toBe("no language server for .gleam")
      expect(spawn).toHaveBeenCalledTimes(1)
    }),
  )

  downloadsAllowed.instance("never downloads a missing server even when downloads are allowed", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const spawn = spyOn(LSPServer.Gleam, "spawn").mockResolvedValue(undefined)
      spies.push(spawn)
      const file = path.join(dir, "main.gleam")
      yield* write(file)

      expect((yield* definition(file)).output).toBe("no language server for .gleam")
      expect(spawn.mock.calls[0]?.[2]).toMatchObject({ disableLspDownload: true })
    }),
  )

  // Typescript and Biome resolve their server through the Npm cache, which
  // installs a missing package. With downloads off (lazy mode always turns
  // them off) only a project-local or PATH binary may be used.
  it.instance(
    "never installs typescript-language-server or biome when downloads are off",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const ctx = yield* InstanceState.context
        const flags = yield* RuntimeFlags.Service.pipe(Effect.provide(RuntimeFlags.layer({ disableLspDownload: true })))
        const empty = path.join(dir, "empty-path")
        yield* Effect.promise(async () => {
          await fs.mkdir(empty, { recursive: true })
          await Bun.write(path.join(dir, "node_modules", "typescript", "lib", "tsserver.js"), "")
          await Bun.write(
            path.join(dir, "node_modules", "typescript", "package.json"),
            JSON.stringify({ name: "typescript", version: "5.0.0" }),
          )
          await Bun.write(path.join(dir, "node_modules", "biome", "index.js"), "")
          await Bun.write(
            path.join(dir, "node_modules", "biome", "package.json"),
            JSON.stringify({ name: "biome", version: "1.0.0", main: "index.js" }),
          )
        })
        const original = process.env.PATH
        process.env.PATH = empty
        const handles = yield* Effect.promise(() =>
          Promise.all([LSPServer.Typescript.spawn(dir, ctx, flags), LSPServer.Biome.spawn(dir, ctx, flags)]),
        ).pipe(Effect.ensuring(Effect.sync(() => (process.env.PATH = original))))
        expect(handles).toEqual([undefined, undefined])
        const cached = yield* Effect.promise(() =>
          fs.readdir(path.join(Global.Path.cache, "packages")).catch(() => [] as string[]),
        )
        expect(cached.filter((name) => name.includes("typescript-language-server") || name.includes("biome"))).toEqual(
          [],
        )
      }),
    30_000,
  )

  it.instance("uses a project-local typescript-language-server when downloads are off", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const dir = (yield* TestInstance).directory
      const ctx = yield* InstanceState.context
      const flags = yield* RuntimeFlags.Service.pipe(Effect.provide(RuntimeFlags.layer({ disableLspDownload: true })))
      const bin = path.join(dir, "node_modules", ".bin", "typescript-language-server")
      yield* Effect.promise(async () => {
        await Bun.write(path.join(dir, "node_modules", "typescript", "lib", "tsserver.js"), "")
        await Bun.write(
          path.join(dir, "node_modules", "typescript", "package.json"),
          JSON.stringify({ name: "typescript", version: "5.0.0" }),
        )
        await Bun.write(bin, "#!/bin/sh\nexit 0\n")
        await fs.chmod(bin, 0o755)
      })
      const handle = yield* Effect.promise(() => LSPServer.Typescript.spawn(dir, ctx, flags))
      expect(handle?.process.spawnfile).toBe(bin)
      handle?.process.kill()
    }),
  )

  it.instance("unsupported extension yields a tool message", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const file = path.join(dir, "notes.zzz")
      yield* write(file)

      expect((yield* definition(file)).output).toBe("no language server for .zzz")
    }),
  )
})

describe("lsp disabled (lsp: false)", () => {
  it.instance(
    "the lsp tool reports that LSP is disabled",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const spawn = fakeBuiltin(LSPServer.Gleam, path.join(dir, "gleam.pid"))
        const file = path.join(dir, "main.gleam")
        yield* write(file)

        expect((yield* definition(file)).output).toBe("LSP is disabled in config (lsp: false)")
        expect(spawn).toHaveBeenCalledTimes(0)
      }),
    { config: { lsp: false } },
  )
})

describe("lsp running-client limits", () => {
  it.instance(
    "starting a fourth server stops the least recently used one",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const lsp = yield* LSP.Service
        const files = ["a", "b", "c", "d"].map((name) => path.join(dir, `file.fake${name}`))
        yield* Effect.forEach(files, write, { discard: true })

        yield* Effect.forEach(files.slice(0, 3), (file) => definition(file), { discard: true })
        // Touch `a` so `b` becomes the least recently used client.
        yield* definition(files[0])
        const pids = yield* Effect.forEach(["a", "b", "c"], (name) => readPid(path.join(dir, `${name}.pid`)))

        yield* definition(files[3])
        expect(yield* gone(pids[1])).toBe(true)
        expect(alive(pids[0])).toBe(true)
        expect(alive(pids[2])).toBe(true)
        expect((yield* lsp.status()).map((item) => item.id).toSorted()).toEqual(["a", "c", "d"])

        // An evicted server is not broken: asking for it again restarts it.
        expect((yield* definition(files[1])).output).toContain("file.fakeb")
        expect((yield* lsp.status()).length).toBe(3)
      }),
    { config: fakeConfig("a", "b", "c", "d") },
  )

  it.effect("a client idle for ten minutes is stopped", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const file = path.join(dir, "file.fakea")
          yield* write(file)

          expect(yield* lsp.start(file)).toBe("ready")
          const pid = yield* readPid(path.join(dir, "a.pid"))

          yield* TestClock.adjust(Duration.minutes(9))
          expect(alive(pid)).toBe(true)
          expect((yield* lsp.status()).length).toBe(1)

          yield* TestClock.adjust(Duration.minutes(2))
          expect(yield* gone(pid)).toBe(true)
          expect(yield* lsp.status()).toEqual([])
        }),
      { config: fakeConfig("a") },
    ),
  )
})
