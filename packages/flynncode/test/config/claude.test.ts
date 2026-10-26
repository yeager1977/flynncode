import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { httpClient } from "@flynncode/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { FSUtil } from "@flynncode/core/fs-util"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import fs from "fs/promises"
import path from "path"
import { Config } from "@/config/config"
import { ConfigClaude } from "@/config/claude"
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
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
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

const fixture = path.join(import.meta.dir, "fixtures", "claude")

const originalHome = process.env.OPENCODE_TEST_HOME
const originalDisable = process.env.OPENCODE_DISABLE_CLAUDE_CODE

afterEach(() => {
  if (originalHome === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = originalHome
  if (originalDisable === undefined) delete process.env.OPENCODE_DISABLE_CLAUDE_CODE
  else process.env.OPENCODE_DISABLE_CLAUDE_CODE = originalDisable
})

const agentFile = (fields: Record<string, string>, body = "Prompt body.") =>
  ["---", ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), "---", "", body, ""].join("\n")

async function writeAgents(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ".claude", "agents", name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, content)
  }
}

describe("ConfigClaude.loadAgents", () => {
  test("parses a Claude Code agent with escaped newlines and a model alias", async () => {
    const result = await ConfigClaude.loadAgents(fixture)
    const agent = result.agents["pilot-pm-expert"]
    expect(result.warnings).toEqual([])
    expect(agent).toMatchObject({
      name: "pilot-pm-expert",
      mode: "subagent",
      prompt: "You are a pilot project manager. Keep pilots small and measurable.",
      options: { claudeModel: "opus" },
    })
    expect(agent.model).toBeUndefined()
    expect(agent.description).toContain("Examples:\n\n<example>\nContext: User is planning")
    expect(agent.description).not.toContain("\\n")
  })

  test("maps Claude tool names to permission rules and denies the rest", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, {
      "reviewer.md": agentFile({
        name: "reviewer",
        description: "Reviews code",
        tools:
          "Read, Grep, Glob, Write, Bash, TodoWrite, AskUserQuestion, FancyTool, mcp__github__get_issue, mcp__linear",
      }),
    })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    expect(result.agents.reviewer.permission).toEqual({
      "*": "deny",
      external_directory: "ask",
      read: "allow",
      grep: "allow",
      glob: "allow",
      edit: "allow",
      bash: "allow",
      todowrite: "allow",
      question: "allow",
      github_get_issue: "allow",
      "linear_*": "allow",
    })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("FancyTool")
    expect(result.warnings[0]).toContain("reviewer.md")
  })

  test("accepts a YAML list of tools", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, {
      "lister.md": [
        "---",
        "name: lister",
        "description: Lists",
        "tools:",
        "  - Read",
        "  - WebFetch",
        "---",
        "Body",
      ].join("\n"),
    })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    expect(result.agents.lister.permission).toEqual({
      "*": "deny",
      external_directory: "ask",
      read: "allow",
      webfetch: "allow",
    })
  })

  test("leaves permissions untouched when tools is absent", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, { "open.md": agentFile({ name: "open", description: "All tools" }) })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    expect(result.agents.open.permission).toEqual({})
  })

  test("maps color names to theme colors and drops unknown ones", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, {
      "red.md": agentFile({ name: "red", description: "Red", color: "red" }),
      "hex.md": agentFile({ name: "hex", description: "Hex", color: "'#112233'" }),
      "odd.md": agentFile({ name: "odd", description: "Odd", color: "chartreuse" }),
    })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    expect(result.agents.red.color).toBe("error")
    expect(result.agents.hex.color).toBe("#112233")
    expect(result.agents.odd).toBeDefined()
    expect(result.agents.odd.color).toBeUndefined()
  })

  test("maps orange, cyan and pink color names", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, {
      "orange.md": agentFile({ name: "orange", description: "Orange", color: "orange" }),
      "cyan.md": agentFile({ name: "cyan", description: "Cyan", color: "cyan" }),
      "pink.md": agentFile({ name: "pink", description: "Pink", color: "pink" }),
    })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    expect(result.agents.orange.color).toBe("warning")
    expect(result.agents.cyan.color).toBe("info")
    expect(result.agents.pink.color).toBe("secondary")
  })

  test("keeps provider/model ids and stores aliases separately", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, {
      "pinned.md": agentFile({ name: "pinned", description: "Pinned", model: "anthropic/claude-sonnet-4-5" }),
      "inherit.md": agentFile({ name: "inherit", description: "Inherit", model: "inherit" }),
    })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    expect(result.agents.pinned.model).toBe("anthropic/claude-sonnet-4-5")
    expect(result.agents.pinned.options?.claudeModel).toBeUndefined()
    expect(result.agents.inherit.model).toBeUndefined()
    expect(result.agents.inherit.options?.claudeModel).toBe("inherit")
  })

  test("skips malformed files with a warning naming the file", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, {
      "broken.md": ["---", "name: broken", "description: Broken", "tools: [Read, Grep", "---", "Body"].join("\n"),
      "nodesc.md": agentFile({ name: "nodesc" }),
      "good.md": agentFile({ name: "good", description: "Good" }),
    })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    expect(Object.keys(result.agents)).toEqual(["good"])
    expect(result.warnings.some((warning) => warning.includes("broken.md"))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes("nodesc.md"))).toBe(true)
  })
})

describe("Config with .claude/agents", () => {
  it.instance(
    "loads user and project Claude agents, project overriding user",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const home = yield* tmpdirScoped()
        process.env.OPENCODE_TEST_HOME = home
        yield* Effect.promise(() =>
          writeAgents(home, {
            "shared.md": agentFile({ name: "shared", description: "From user" }),
            "user-only.md": agentFile({ name: "user-only", description: "User only" }),
          }),
        )
        yield* Effect.promise(() =>
          writeAgents(test.directory, { "shared.md": agentFile({ name: "shared", description: "From project" }) }),
        )
        const config = yield* Config.use.get()
        expect(config.agent?.shared?.description).toBe("From project")
        expect(config.agent?.["user-only"]?.mode).toBe("subagent")
      }),
    { git: true },
  )

  it.instance(
    "native .opencode agents win over Claude agents with the same name",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          writeAgents(test.directory, {
            "helper.md": agentFile({ name: "helper", description: "Claude helper", tools: "Read" }),
          }),
        )
        yield* FSUtil.use.writeWithDirs(
          path.join(test.directory, ".opencode", "agents", "helper.md"),
          ["---", "description: Native helper", "mode: subagent", "---", "Native prompt"].join("\n"),
        )
        const config = yield* Config.use.get()
        expect(config.agent?.helper?.description).toBe("Native helper")
        expect(config.agent?.helper?.prompt).toBe("Native prompt")
        expect(config.agent?.helper?.permission?.["*"]).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "malformed Claude agents never fail config loading",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          writeAgents(test.directory, {
            "broken.md": ["---", "description: Broken", "tools: [Read", "---", "Body"].join("\n"),
            "fine.md": agentFile({ name: "fine", description: "Fine", color: "purple", tools: "Read, Mystery" }),
          }),
        )
        const config = yield* Config.use.get()
        expect(config.agent?.fine?.color).toBe("accent")
        expect(config.agent?.broken).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "OPENCODE_DISABLE_CLAUDE_CODE turns the loader off",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        process.env.OPENCODE_DISABLE_CLAUDE_CODE = "1"
        yield* Effect.promise(() =>
          writeAgents(test.directory, { "off.md": agentFile({ name: "off", description: "Off" }) }),
        )
        const config = yield* Config.use.get()
        expect(config.agent?.off).toBeUndefined()
      }),
    { git: true },
  )
})
