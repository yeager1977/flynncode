import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { httpClient } from "@flynncode/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { FSUtil } from "@flynncode/core/fs-util"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { ConfigClaude } from "@/config/claude"
import { HooksTrust } from "@/hooks/trust"
import { enumerateHooks } from "@/hooks/executor"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { Npm } from "@flynncode/core/npm"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node, HooksTrust.node]), [
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
  ]),
)

const saved = Object.fromEntries(
  [
    "OPENCODE_TEST_HOME",
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_CLAUDE_HOOKS",
    "FLYNNCODE_HOOKS_TRUST_FILE",
  ].map((name) => [name, process.env[name]]),
)

const trustPath = path.join(os.tmpdir(), `flynncode-claude-hooks-trust-${process.pid}.json`)

beforeEach(async () => {
  process.env.FLYNNCODE_HOOKS_TRUST_FILE = trustPath
  await Bun.write(trustPath, "[]")
})

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Bun.file(trustPath)
    .delete()
    .catch(() => undefined)
})

const write = (file: string, value: unknown) =>
  Bun.write(file, typeof value === "string" ? value : JSON.stringify(value, null, 2))

const command = (value: string) => ({ type: "command" as const, command: value })

// A fake HOME with Claude user settings, a local settings file, an installed
// plugin list with an enabled plugin (two installs, the user one preferred)
// and a plugin disabled in Claude.
async function fakeClaude(home: string) {
  const claude = path.join(home, ".claude")
  const alpha = path.join(home, "plugins", "alpha", "1.0.0")
  const alphaProject = path.join(home, "plugins", "alpha", "0.9.0")
  const beta = path.join(home, "plugins", "beta", "1.0.0")
  await write(path.join(claude, "settings.json"), {
    model: "opus",
    permissions: { allow: ["Bash(ls:*)"] },
    enabledPlugins: { "alpha@market": true, "beta@market": false },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [command("user-pre.sh")] }] },
  })
  await write(path.join(claude, "settings.local.json"), {
    hooks: { SessionStart: [{ hooks: [command("user-local.sh")] }] },
  })
  await write(path.join(claude, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "alpha@market": [
        { scope: "user", installPath: alpha, version: "1.0.0" },
        { scope: "project", installPath: alphaProject, version: "0.9.0" },
      ],
      "beta@market": [{ scope: "user", installPath: beta, version: "1.0.0" }],
    },
  })
  await write(path.join(alpha, "hooks", "hooks.json"), {
    hooks: { Stop: [{ hooks: [command("${CLAUDE_PLUGIN_ROOT}/hooks/run.cmd judge")] }] },
  })
  await write(path.join(alphaProject, "hooks", "hooks.json"), {
    hooks: { Stop: [{ hooks: [command("old-alpha.sh")] }] },
  })
  await write(path.join(beta, "hooks", "hooks.json"), {
    hooks: { PreToolUse: [{ hooks: [command("beta.sh")] }] },
  })
  return { claude, alpha }
}

async function fakeProject(root: string) {
  const dir = path.join(root, ".claude")
  await write(path.join(dir, "settings.json"), {
    hooks: { Stop: [{ hooks: [command('"${CLAUDE_PROJECT_DIR}/stop.sh" --strict')] }] },
  })
  await write(path.join(dir, "settings.local.json"), {
    hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [command("project-local.sh")] }] },
  })
  return dir
}

describe("ConfigClaude.loadHooks", () => {
  test("loads user, project and enabled plugin hooks with tags, env and expanded variables", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir()
    const claude = await fakeClaude(home.path)
    const dir = await fakeProject(project.path)
    const result = await ConfigClaude.loadHooks({
      home: home.path,
      projectDirs: [dir],
      projectRoot: project.path,
      disabled: new Set(),
    })
    expect(result.warnings).toEqual([])
    const projectEnv = { CLAUDE_PROJECT_DIR: project.path }
    const pluginEnv = {
      CLAUDE_PROJECT_DIR: project.path,
      CLAUDE_PLUGIN_ROOT: claude.alpha,
      CLAUDE_PLUGIN_DATA: path.join(claude.claude, "plugins", "data", "alpha-market"),
    }
    expect(result.hooks).toEqual({
      PreToolUse: [
        { matcher: "Bash", hooks: [command("user-pre.sh")], format: "claude", source: "claude:user", env: projectEnv },
      ],
      SessionStart: [{ hooks: [command("user-local.sh")], format: "claude", source: "claude:user", env: projectEnv }],
      Stop: [
        {
          hooks: [command(`"${project.path}/stop.sh" --strict`)],
          format: "claude",
          source: `claude:project:${dir}`,
          env: projectEnv,
        },
        {
          hooks: [command(`${claude.alpha}/hooks/run.cmd judge`)],
          format: "claude",
          source: "claude:plugin:alpha@market",
          env: pluginEnv,
        },
      ],
      PostToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [command("project-local.sh")],
          format: "claude",
          source: `claude:project:${dir}`,
          env: projectEnv,
        },
      ],
    })
    expect(result.sources).toEqual([
      {
        id: "claude:user",
        kind: "user",
        label: expect.any(String),
        root: claude.claude,
        events: ["PreToolUse", "SessionStart"],
        commands: ["user-pre.sh", "user-local.sh"],
        enabled: true,
        warnings: [],
      },
      {
        id: `claude:project:${dir}`,
        kind: "project",
        label: expect.any(String),
        root: dir,
        events: ["Stop", "PostToolUse"],
        commands: [`"${project.path}/stop.sh" --strict`, "project-local.sh"],
        enabled: true,
        warnings: [],
      },
      {
        id: "claude:plugin:alpha@market",
        kind: "plugin",
        label: expect.stringContaining("alpha@market"),
        root: claude.alpha,
        events: ["Stop"],
        commands: [`${claude.alpha}/hooks/run.cmd judge`],
        enabled: true,
        warnings: [],
      },
    ])
  })

  test("a missing install path warns and the other sources still load", async () => {
    await using home = await tmpdir()
    await fakeClaude(home.path)
    const claude = path.join(home.path, ".claude")
    await write(path.join(claude, "settings.json"), {
      enabledPlugins: { "alpha@market": true, "gone@market": true, "unknown@market": true },
      hooks: { PreToolUse: [{ hooks: [command("user-pre.sh")] }] },
    })
    const installed = await Bun.file(path.join(claude, "plugins", "installed_plugins.json")).json()
    await write(path.join(claude, "plugins", "installed_plugins.json"), {
      ...installed,
      plugins: {
        ...installed.plugins,
        "gone@market": [{ scope: "user", installPath: path.join(home.path, "plugins", "gone") }],
      },
    })
    const result = await ConfigClaude.loadHooks({
      home: home.path,
      projectDirs: [],
      projectRoot: home.path,
      disabled: new Set(),
    })
    expect(result.warnings).toEqual([expect.stringContaining("gone@market"), expect.stringContaining("unknown@market")])
    expect(result.hooks.PreToolUse?.map((group) => group.source)).toEqual(["claude:user"])
    expect(result.hooks.Stop?.map((group) => group.source)).toEqual(["claude:plugin:alpha@market"])
    const gone = result.sources.find((source) => source.id === "claude:plugin:gone@market")
    expect(gone).toMatchObject({ kind: "plugin", enabled: true, events: [], commands: [] })
    expect(gone?.warnings).toEqual([expect.stringContaining(path.join(home.path, "plugins", "gone"))])
  })

  test("invalid JSON, unknown events and unknown handler types warn and are skipped", async () => {
    await using home = await tmpdir()
    const { claude, alpha } = await fakeClaude(home.path)
    await write(path.join(claude, "settings.local.json"), "{ not json")
    await write(path.join(alpha, "hooks", "hooks.json"), {
      hooks: {
        Stop: [{ hooks: [{ type: "agent", prompt: "check" }, command("kept.sh")] }],
        TeammateIdle: [{ hooks: [command("idle.sh")] }],
      },
    })
    const result = await ConfigClaude.loadHooks({
      home: home.path,
      projectDirs: [],
      projectRoot: home.path,
      disabled: new Set(),
    })
    expect(result.warnings).toEqual([
      expect.stringContaining(path.join(claude, "settings.local.json")),
      expect.stringContaining("agent"),
      expect.stringContaining("TeammateIdle"),
    ])
    expect(result.hooks.PreToolUse?.[0]?.hooks).toEqual([command("user-pre.sh")])
    expect(result.hooks.SessionStart).toBeUndefined()
    expect(result.hooks.Stop?.[0]?.hooks).toEqual([command("kept.sh")])
    expect(Object.keys(result.hooks)).not.toContain("TeammateIdle")
    expect(result.sources.find((source) => source.id === "claude:user")?.warnings).toHaveLength(1)
  })

  test("an invalid installed_plugins.json warns and user hooks still load", async () => {
    await using home = await tmpdir()
    const { claude } = await fakeClaude(home.path)
    await write(path.join(claude, "plugins", "installed_plugins.json"), "[oops")
    const result = await ConfigClaude.loadHooks({
      home: home.path,
      projectDirs: [],
      projectRoot: home.path,
      disabled: new Set(),
    })
    expect(result.warnings).toEqual([expect.stringContaining("installed_plugins.json")])
    expect(result.hooks.PreToolUse?.map((group) => group.source)).toEqual(["claude:user"])
    expect(result.sources.map((source) => source.id)).toEqual(["claude:user"])
  })

  test("a missing ~/.claude loads nothing and warns about nothing", async () => {
    const result = await ConfigClaude.loadHooks({
      home: path.join(os.tmpdir(), `flynncode-no-home-${process.pid}`),
      projectDirs: [],
      projectRoot: os.tmpdir(),
      disabled: new Set(),
    })
    expect(result).toEqual({ hooks: {}, sources: [], warnings: [] })
  })

  test("switched-off sources are listed but contribute no hooks", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir()
    const { alpha } = await fakeClaude(home.path)
    const dir = await fakeProject(project.path)
    const result = await ConfigClaude.loadHooks({
      home: home.path,
      projectDirs: [dir],
      projectRoot: project.path,
      disabled: new Set(["claude:plugin:alpha@market", "claude:user"]),
    })
    expect(result.hooks.PreToolUse).toBeUndefined()
    expect(result.hooks.SessionStart).toBeUndefined()
    expect(result.hooks.Stop?.map((group) => group.source)).toEqual([`claude:project:${dir}`])
    expect(result.sources.map((source) => [source.id, source.enabled])).toEqual([
      ["claude:user", false],
      [`claude:project:${dir}`, true],
      ["claude:plugin:alpha@market", false],
    ])
    expect(result.sources.find((source) => source.id === "claude:plugin:alpha@market")).toMatchObject({
      events: ["Stop"],
      commands: [`${alpha}/hooks/run.cmd judge`],
    })
  })
})

describe("Claude hook trust", () => {
  const loaded = async (home: string, project: string, dir: string) =>
    enumerateHooks(
      (await ConfigClaude.loadHooks({ home, projectDirs: [dir], projectRoot: project, disabled: new Set() })).hooks,
    )

  it.live("plugin and project hooks need trust once, and again when their command changes", () =>
    Effect.gen(function* () {
      const trust = yield* HooksTrust.Service
      const home = yield* tmpdirScoped()
      const project = yield* tmpdirScoped()
      const dir = yield* Effect.promise(async () => {
        await fakeClaude(home)
        return fakeProject(project)
      })
      const before = yield* Effect.promise(() => loaded(home, project, dir))
      const plugin = before.find((item) => item.def.source === "claude:plugin:alpha@market")
      const local = before.find((item) => item.def.source === `claude:project:${dir}`)
      if (!plugin || !local) throw new Error("missing Claude hooks")
      expect(yield* trust.isTrusted(plugin.def)).toBe(false)
      expect(yield* trust.isTrusted(local.def)).toBe(false)
      yield* trust.trust(plugin.def)
      expect(yield* trust.isTrusted(plugin.def)).toBe(true)

      // The same command under another source is a different hook.
      expect(yield* trust.isTrusted({ ...plugin.def, source: "claude:plugin:other@market" })).toBe(false)

      yield* Effect.promise(() =>
        write(path.join(home, "plugins", "alpha", "1.0.0", "hooks", "hooks.json"), {
          hooks: { Stop: [{ hooks: [command("${CLAUDE_PLUGIN_ROOT}/hooks/run.cmd judge --again")] }] },
        }),
      )
      const after = yield* Effect.promise(() => loaded(home, project, dir))
      const changed = after.find((item) => item.def.source === "claude:plugin:alpha@market")
      if (!changed) throw new Error("missing changed plugin hook")
      expect(changed.hash).not.toBe(plugin.hash)
      expect(yield* trust.isTrusted(changed.def)).toBe(false)
    }),
  )

  it.live("Claude user hooks are trusted without review; native hooks are unchanged", () =>
    Effect.gen(function* () {
      const trust = yield* HooksTrust.Service
      const home = yield* tmpdirScoped()
      const project = yield* tmpdirScoped()
      const dir = yield* Effect.promise(async () => {
        await fakeClaude(home)
        return fakeProject(project)
      })
      const user = (yield* Effect.promise(() => loaded(home, project, dir))).filter(
        (item) => item.def.source === "claude:user",
      )
      expect(user).toHaveLength(2)
      for (const item of user) expect(yield* trust.isTrusted(item.def)).toBe(true)
      expect(HooksTrust.sourceTrusted(user[0].def)).toBe(true)
      const native = HooksTrust.fromHandler("PreToolUse", "Bash", { type: "command", command: "user-pre.sh" })
      expect(native.source).toBeUndefined()
      expect(yield* trust.isTrusted(native)).toBe(false)
      expect(HooksTrust.hashDef(native)).not.toBe(user[0].hash)
    }),
  )
})

describe("Config with Claude Code hooks", () => {
  it.instance(
    "appends Claude groups after every native hook and strips internal tags from native files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const home = yield* tmpdirScoped()
        process.env.OPENCODE_TEST_HOME = home
        const dir = yield* Effect.promise(async () => {
          await fakeClaude(home)
          await write(path.join(test.directory, ".opencode", "hooks.json"), {
            PreToolUse: [
              // A config file must never pose as a trusted Claude source.
              { matcher: "Bash", hooks: [command("native-pre.sh")], source: "claude:user", format: "claude" },
            ],
            Stop: [{ hooks: [command("native-stop.sh")] }],
          })
          return fakeProject(test.directory)
        })
        const config = yield* Config.use.get()
        expect(config.hooks?.PreToolUse).toEqual([
          { matcher: "Bash", hooks: [command("native-pre.sh")] },
          {
            matcher: "Bash",
            hooks: [command("user-pre.sh")],
            format: "claude",
            source: "claude:user",
            env: { CLAUDE_PROJECT_DIR: test.directory },
          },
        ])
        expect(config.hooks?.Stop?.map((group) => group.source)).toEqual([
          undefined,
          `claude:project:${dir}`,
          "claude:plugin:alpha@market",
        ])
      }),
    { git: true },
  )

  it.instance(
    "claude_hooks.disabled switches a source off",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const home = yield* tmpdirScoped()
        process.env.OPENCODE_TEST_HOME = home
        yield* Effect.promise(async () => {
          await fakeClaude(home)
          await write(path.join(test.directory, "opencode.json"), {
            claude_hooks: { disabled: ["claude:plugin:alpha@market"] },
          })
        })
        const config = yield* Config.use.get()
        expect(config.claude_hooks?.disabled).toEqual(["claude:plugin:alpha@market"])
        expect(config.hooks?.Stop).toBeUndefined()
        expect(config.hooks?.PreToolUse?.map((group) => group.source)).toEqual(["claude:user"])
      }),
    { git: true },
  )

  for (const flag of ["OPENCODE_DISABLE_CLAUDE_HOOKS", "OPENCODE_DISABLE_CLAUDE_CODE"]) {
    it.instance(
      `${flag} loads no Claude hooks and keeps native ones`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const home = yield* tmpdirScoped()
          process.env.OPENCODE_TEST_HOME = home
          process.env[flag] = "1"
          yield* Effect.promise(async () => {
            await fakeClaude(home)
            await fakeProject(test.directory)
            await write(path.join(test.directory, ".opencode", "hooks.json"), {
              Stop: [{ hooks: [command("native-stop.sh")] }],
            })
          })
          const config = yield* Config.use.get()
          expect(config.hooks).toEqual({ Stop: [{ hooks: [command("native-stop.sh")] }] })
        }),
      { git: true },
    )
  }
})

describe("RuntimeFlags.disableClaudeHooks", () => {
  const read = (input: Record<string, unknown>) =>
    Effect.runPromise(
      RuntimeFlags.Service.useSync((flags) => flags.disableClaudeHooks).pipe(
        Effect.provide(
          AppNodeBuilder.build(RuntimeFlags.node).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))),
          ),
        ),
      ),
    )

  test("follows OPENCODE_DISABLE_CLAUDE_HOOKS and OPENCODE_DISABLE_CLAUDE_CODE", async () => {
    expect(await read({})).toBe(false)
    expect(await read({ OPENCODE_DISABLE_CLAUDE_HOOKS: "true" })).toBe(true)
    expect(await read({ OPENCODE_DISABLE_CLAUDE_CODE: "true" })).toBe(true)
  })
})
