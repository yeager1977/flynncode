import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { httpClient } from "@flynncode/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { FSUtil } from "@flynncode/core/fs-util"
import { Npm } from "@flynncode/core/npm"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { mkdirSync } from "fs"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { ConfigClaude } from "@/config/claude"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// os.tmpdir() falls back to /tmp, a quota-limited tmpfs, when TMPDIR is unset.
process.env.TMPDIR ??= path.join(os.homedir(), ".cache", "flynncode-test-tmp")
mkdirSync(process.env.TMPDIR, { recursive: true })

const overrides = [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [
    httpClient,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.die(request.url)),
    ),
  ],
] as const

const nodes = LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node])
const it = testEffect(LayerNode.compile(nodes, [...overrides]))
const withoutClaudeHooks = testEffect(
  LayerNode.compile(nodes, [...overrides, [RuntimeFlags.node, RuntimeFlags.layer({ disableClaudeHooks: true })]]),
)

const savedHome = process.env.OPENCODE_TEST_HOME
afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = savedHome
})

const write = (file: string, value: unknown) => Bun.write(file, JSON.stringify(value, null, 2))
const line = (command: string, padding?: number) => ({
  type: "command" as const,
  command,
  ...(padding === undefined ? {} : { padding }),
})

describe("ConfigClaude.loadStatusLine", () => {
  test("the closest settings file wins: project local over project over user local over user", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir()
    const claude = path.join(home.path, ".claude")
    const dir = path.join(project.path, ".claude")
    const load = () =>
      ConfigClaude.loadStatusLine({
        home: home.path,
        projectDirs: [dir],
        projectRoot: project.path,
        disabled: new Set(),
      })

    expect((await load()).statusLine).toBeUndefined()
    await write(path.join(claude, "settings.json"), { statusLine: line("user.sh", 2) })
    expect((await load()).statusLine).toEqual({ ...line("user.sh", 2), source: "claude:user" })
    await write(path.join(claude, "settings.local.json"), { statusLine: line("user-local.sh") })
    expect((await load()).statusLine).toEqual({ ...line("user-local.sh"), source: "claude:user" })
    await write(path.join(dir, "settings.json"), { statusLine: line('"$CLAUDE_PROJECT_DIR"/.claude/status.sh') })
    expect((await load()).statusLine).toEqual({
      ...line(`"${project.path}"/.claude/status.sh`),
      source: `claude:project:${dir}`,
    })
    await write(path.join(dir, "settings.local.json"), { statusLine: line("${CLAUDE_PROJECT_DIR}/local.sh") })
    expect((await load()).statusLine).toEqual({ ...line(`${project.path}/local.sh`), source: `claude:project:${dir}` })
  })

  test("a disabled source, disableAllHooks and unsupported shapes are skipped", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir()
    const claude = path.join(home.path, ".claude")
    const dir = path.join(project.path, ".claude")
    const load = (disabled: string[] = []) =>
      ConfigClaude.loadStatusLine({
        home: home.path,
        projectDirs: [dir],
        projectRoot: project.path,
        disabled: new Set(disabled),
      })
    await write(path.join(claude, "settings.json"), { statusLine: line("user.sh") })
    await write(path.join(dir, "settings.json"), { statusLine: line("project.sh") })

    expect((await load([`claude:project:${dir}`])).statusLine?.command).toBe("user.sh")
    expect((await load([`claude:project:${dir}`, "claude:user"])).statusLine).toBeUndefined()

    await write(path.join(dir, "settings.local.json"), { disableAllHooks: true })
    expect((await load()).statusLine?.command).toBe("user.sh")
    await write(path.join(claude, "settings.local.json"), { disableAllHooks: true })
    expect((await load()).statusLine).toBeUndefined()

    await write(path.join(claude, "settings.local.json"), {})
    await write(path.join(dir, "settings.local.json"), { statusLine: { type: "static", text: "hi" } })
    const loaded = await load()
    expect(loaded.statusLine?.command).toBe("project.sh")
    expect(loaded.warnings).toEqual([
      `skipped Claude statusLine in ${path.join(dir, "settings.local.json")}: only { type: "command", command } is supported`,
    ])
  })
})

describe("Config statusLine", () => {
  it.instance(
    "falls back to Claude settings only without a native statusLine, and native files cannot claim a source",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const home = yield* tmpdirScoped()
        process.env.OPENCODE_TEST_HOME = home
        yield* Effect.promise(() =>
          write(path.join(home, ".claude", "settings.json"), { statusLine: line("claude.sh", 1) }),
        )
        expect((yield* Config.use.get()).statusLine).toEqual({ ...line("claude.sh", 1), source: "claude:user" })

        yield* Effect.promise(() =>
          write(path.join(test.directory, "opencode.json"), {
            statusLine: { ...line("native.sh"), source: "claude:user" },
          }),
        )
        yield* Config.use.invalidate()
        expect((yield* Config.use.get()).statusLine).toEqual(line("native.sh"))
      }),
    { git: true },
  )

  withoutClaudeHooks.instance(
    "the Claude disable flags turn the fallback off",
    () =>
      Effect.gen(function* () {
        const home = yield* tmpdirScoped()
        process.env.OPENCODE_TEST_HOME = home
        yield* Effect.promise(() =>
          write(path.join(home, ".claude", "settings.json"), { statusLine: line("claude.sh") }),
        )
        expect((yield* Config.use.get()).statusLine).toBeUndefined()
      }),
    { git: true },
  )
})
