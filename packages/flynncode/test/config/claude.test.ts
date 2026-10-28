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

  test("maps Claude tool names to scopes and denies only unlisted built-ins", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, {
      "reviewer.md": agentFile({
        name: "reviewer",
        description: "Reviews code",
        tools:
          "Read, Grep, Glob, Write, Bash, TodoWrite, AskUserQuestion, NotebookEdit, FancyTool, mcp__github__get_issue, mcp__linear",
      }),
    })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    const agent = result.agents.reviewer
    // Restrict only: a tools list never emits an allow rule.
    expect(Object.values(agent.permission ?? {}).every((action) => action === "deny")).toBe(true)
    for (const key of ["read", "grep", "glob", "edit", "bash", "todowrite", "question", "external_directory"])
      expect(agent.permission?.[key]).toBeUndefined()
    for (const key of ["webfetch", "websearch", "task", "skill", "lsp", "computer_use", "multiedit", "notebook_edit"])
      expect(agent.permission?.[key]).toBe("deny")
    expect(agent.options?.claudeTools).toEqual([
      { permission: "external_directory", pattern: "*" },
      { permission: "doom_loop", pattern: "*" },
      { permission: "read", pattern: "*" },
      { permission: "grep", pattern: "*" },
      { permission: "glob", pattern: "*" },
      { permission: "edit", pattern: "*" },
      { permission: "bash", pattern: "*" },
      { permission: "todowrite", pattern: "*" },
      { permission: "question", pattern: "*" },
      { permission: "edit", pattern: "*.ipynb" },
      { permission: "github_get_issue", pattern: "*" },
      { permission: "linear_*", pattern: "*" },
    ])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("FancyTool")
    expect(result.warnings[0]).toContain("reviewer.md")
  })

  test("maps the Claude scheduling tools onto the schedule permission", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, {
      "planner.md": agentFile({
        name: "planner",
        description: "Plans",
        tools: "Read, CronCreate, CronList, CronDelete, ScheduleWakeup",
      }),
      "reader.md": agentFile({ name: "reader", description: "Reads", tools: "Read" }),
    })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    expect(result.warnings).toEqual([])
    expect(result.agents.planner.permission?.schedule).toBeUndefined()
    expect(result.agents.reader.permission?.schedule).toBe("deny")
    expect(result.agents.planner.options?.claudeTools).toContainEqual({ permission: "schedule", pattern: "*" })
  })

  test("maps the Claude worktree tools onto the worktree permission", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, {
      "isolator.md": agentFile({ name: "isolator", description: "Isolates", tools: "Read, EnterWorktree, ExitWorktree" }),
      "reader.md": agentFile({ name: "reader", description: "Reads", tools: "Read" }),
    })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    expect(result.warnings).toEqual([])
    expect(result.agents.isolator.permission?.worktree).toBeUndefined()
    expect(result.agents.reader.permission?.worktree).toBe("deny")
    expect(result.agents.isolator.options?.claudeTools).toContainEqual({ permission: "worktree", pattern: "*" })
  })

  test("never maps mcp__ tools onto built-in permissions", async () => {
    await using tmp = await tmpdir()
    await writeAgents(tmp.path, {
      "sneaky.md": agentFile({
        name: "sneaky",
        description: "Sneaky",
        tools:
          "Read, mcp__external__directory, mcp__external, mcp__list, mcp__notebook, mcp__bash, mcp__github__get_issue",
      }),
    })
    const result = await ConfigClaude.loadAgents(path.join(tmp.path, ".claude"))
    expect(result.agents.sneaky.options?.claudeTools).toEqual([
      { permission: "external_directory", pattern: "*" },
      { permission: "doom_loop", pattern: "*" },
      { permission: "read", pattern: "*" },
      { permission: "github_get_issue", pattern: "*" },
    ])
    expect(result.agents.sneaky.permission?.bash).toBe("deny")
    expect(result.agents.sneaky.permission?.list).toBe("deny")
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("sneaky.md")
    for (const item of ["mcp__external__directory", "mcp__external", "mcp__list", "mcp__notebook", "mcp__bash"])
      expect(result.warnings[0]).toContain(item)
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
    expect(result.agents.lister.options?.claudeTools).toEqual([
      { permission: "external_directory", pattern: "*" },
      { permission: "doom_loop", pattern: "*" },
      { permission: "read", pattern: "*" },
      { permission: "webfetch", pattern: "*" },
    ])
    expect(result.agents.lister.permission?.bash).toBe("deny")
    expect(result.agents.lister.permission?.read).toBeUndefined()
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
        expect(config.agent?.helper?.permission?.bash).toBeUndefined()
        expect(config.agent?.helper?.options?.claudeTools).toBeUndefined()
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

const commandFile = (fields: Record<string, string>, body = "Do the thing.") =>
  ["---", ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), "---", "", body, ""].join("\n")

async function writeCommands(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ".claude", "commands", name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, content)
  }
}

describe("ConfigClaude.loadCommands", () => {
  test("namespaces nested directories with colons", async () => {
    await using tmp = await tmpdir()
    await writeCommands(tmp.path, {
      "plain.md": commandFile({ description: "Plain" }, "Plain body"),
      "git/pr.md": commandFile({ description: "Open a PR" }, "Open it"),
      "a/b/deep.md": commandFile({ description: "Deep" }, "Deep body"),
    })
    const result = await ConfigClaude.loadCommands(path.join(tmp.path, ".claude"))
    expect(Object.keys(result.commands).toSorted()).toEqual(["a:b:deep", "git:pr", "plain"])
    expect(result.commands["git:pr"].template).toBe("Open it")
    expect(result.warnings).toEqual([])
  })

  test("carries frontmatter fields", async () => {
    await using tmp = await tmpdir()
    await writeCommands(tmp.path, {
      "commit.md": [
        "---",
        "description: Create a commit",
        "argument-hint: [message]",
        "allowed-tools: Bash(git add:*), Bash(git status:*), Read",
        "model: haiku",
        "disable-model-invocation: true",
        "---",
        "Commit with $ARGUMENTS",
      ].join("\n"),
      "list.md": [
        "---",
        "description: List",
        "allowed-tools:",
        "  - Read",
        "  - Grep",
        "model: anthropic/claude-sonnet-4-5",
        "argument-hint: <name> [flags]",
        "---",
        "List",
      ].join("\n"),
    })
    const result = await ConfigClaude.loadCommands(path.join(tmp.path, ".claude"))
    expect(result.warnings).toEqual([])
    expect(result.commands.commit).toMatchObject({
      description: "Create a commit",
      template: "Commit with $ARGUMENTS",
      argumentHint: "[message]",
      allowedTools: ["Bash(git add:*)", "Bash(git status:*)", "Read"],
      disableModelInvocation: true,
      claudeModel: "haiku",
    })
    expect(result.commands.commit.model).toBeUndefined()
    expect(result.commands.list).toMatchObject({
      allowedTools: ["Read", "Grep"],
      model: "anthropic/claude-sonnet-4-5",
      argumentHint: "<name> [flags]",
    })
    expect(result.commands.list.claudeModel).toBeUndefined()
  })

  test("reads Claude frontmatter that is invalid YAML", async () => {
    await using tmp = await tmpdir()
    await writeCommands(tmp.path, {
      "review.md": [
        "---",
        "argument-hint: [pr-number] [priority]",
        "allowed-tools: Bash(git add:*), Bash(git status:*)",
        "description: Review a pull request",
        "disable-model-invocation: true",
        "---",
        "Review PR $1",
      ].join("\n"),
    })
    const result = await ConfigClaude.loadCommands(path.join(tmp.path, ".claude"))
    expect(result.warnings).toEqual([])
    expect(result.commands.review).toMatchObject({
      argumentHint: "[pr-number] [priority]",
      allowedTools: ["Bash(git add:*)", "Bash(git status:*)"],
      disableModelInvocation: true,
      description: "Review a pull request",
    })
  })

  test("leaves optional fields unset when absent", async () => {
    await using tmp = await tmpdir()
    await writeCommands(tmp.path, { "bare.md": "Just a body" })
    const result = await ConfigClaude.loadCommands(path.join(tmp.path, ".claude"))
    expect(result.commands.bare.template).toBe("Just a body")
    expect(result.commands.bare.allowedTools).toBeUndefined()
    expect(result.commands.bare.argumentHint).toBeUndefined()
    expect(result.commands.bare.disableModelInvocation).toBeUndefined()
  })

  test("skips malformed files with a warning naming the file", async () => {
    await using tmp = await tmpdir()
    await writeCommands(tmp.path, {
      "broken.md": ["---", "description: Broken", "allowed-tools: [Read", "---", "Body"].join("\n"),
      "empty.md": commandFile({ description: "Empty" }, ""),
      "badflag.md": commandFile({ description: "Bad", "disable-model-invocation": "maybe" }),
      "good.md": commandFile({ description: "Good" }),
    })
    const result = await ConfigClaude.loadCommands(path.join(tmp.path, ".claude"))
    expect(Object.keys(result.commands)).toEqual(["good"])
    for (const name of ["broken.md", "empty.md", "badflag.md"])
      expect(result.warnings.some((warning) => warning.includes(name))).toBe(true)
  })

  test("warns on non-provider model ids and uses the session model", async () => {
    await using tmp = await tmpdir()
    await writeCommands(tmp.path, {
      "old.md": commandFile({ description: "Old", model: "claude-3-5-haiku-20241022" }),
    })
    const result = await ConfigClaude.loadCommands(path.join(tmp.path, ".claude"))
    expect(result.commands.old.model).toBeUndefined()
    expect(result.commands.old.claudeModel).toBeUndefined()
    expect(result.warnings.some((warning) => warning.includes("old.md") && warning.includes("claude-3-5-haiku"))).toBe(
      true,
    )
  })
})

describe("Config with .claude/commands", () => {
  it.instance(
    "loads user and project Claude commands, project overriding user",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const home = yield* tmpdirScoped()
        process.env.OPENCODE_TEST_HOME = home
        yield* Effect.promise(() =>
          writeCommands(home, {
            "shared.md": commandFile({ description: "From user" }, "user body"),
            "ns/user-only.md": commandFile({ description: "User only" }),
          }),
        )
        yield* Effect.promise(() =>
          writeCommands(test.directory, { "shared.md": commandFile({ description: "From project" }, "project body") }),
        )
        const config = yield* Config.use.get()
        expect(config.command?.shared?.description).toBe("From project")
        expect(config.command?.shared?.template).toBe("project body")
        expect(config.command?.["ns:user-only"]?.description).toBe("User only")
        expect(config.command?.shared?.claudeSource).toContain("shared.md")
      }),
    { git: true },
  )

  it.instance(
    "native .opencode commands win over Claude commands with the same name",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          writeCommands(test.directory, {
            "helper.md": commandFile({ description: "Claude helper", "allowed-tools": "Read" }, "claude body"),
          }),
        )
        yield* FSUtil.use.writeWithDirs(
          path.join(test.directory, ".opencode", "commands", "helper.md"),
          ["---", "description: Native helper", "---", "native body"].join("\n"),
        )
        const config = yield* Config.use.get()
        expect(config.command?.helper?.description).toBe("Native helper")
        expect(config.command?.helper?.template).toBe("native body")
        expect(config.command?.helper?.allowedTools).toBeUndefined()
        expect(config.command?.helper?.claudeSource).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "malformed Claude commands never fail config loading",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          writeCommands(test.directory, {
            "broken.md": ["---", "description: Broken", "allowed-tools: [Read", "---", "Body"].join("\n"),
            "fine.md": commandFile({ description: "Fine" }),
          }),
        )
        const config = yield* Config.use.get()
        expect(config.command?.fine?.description).toBe("Fine")
        expect(config.command?.broken).toBeUndefined()
      }),
    { git: true },
  )

  for (const flag of ["OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_CLAUDE_CODE_COMMANDS"]) {
    it.instance(
      `${flag} turns the command loader off`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const original = process.env[flag]
          process.env[flag] = "1"
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (original === undefined) delete process.env[flag]
              else process.env[flag] = original
            }),
          )
          yield* Effect.promise(() =>
            writeCommands(test.directory, { "off.md": commandFile({ description: "Off" }) }),
          )
          const config = yield* Config.use.get()
          expect(config.command?.off).toBeUndefined()
        }),
      { git: true },
    )
  }

  it.instance(
    "OPENCODE_DISABLE_CLAUDE_CODE_COMMANDS keeps Claude agents loading",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const original = process.env.OPENCODE_DISABLE_CLAUDE_CODE_COMMANDS
        process.env.OPENCODE_DISABLE_CLAUDE_CODE_COMMANDS = "1"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (original === undefined) delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_COMMANDS
            else process.env.OPENCODE_DISABLE_CLAUDE_CODE_COMMANDS = original
          }),
        )
        yield* Effect.promise(() =>
          writeAgents(test.directory, { "kept.md": agentFile({ name: "kept", description: "Kept" }) }),
        )
        const config = yield* Config.use.get()
        expect(config.agent?.kept).toBeDefined()
      }),
    { git: true },
  )
})

describe("ConfigClaude.allowedToolRules", () => {
  test("converts Claude allowed-tools into allow rules", () => {
    const result = ConfigClaude.allowedToolRules([
      "Read",
      "Bash(git add:*)",
      "Bash(npm test)",
      "Bash",
      "mcp__github__create_issue",
      "mcp__linear",
      "Write",
      "NotebookEdit",
      "Frobnicate",
      "Read(./secrets/**)",
    ])
    expect(result.rules).toEqual([
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "git add *", action: "allow" },
      { permission: "bash", pattern: "npm test", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "github_create_issue", pattern: "*", action: "allow" },
      { permission: "linear_*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*.ipynb", action: "allow" },
    ])
    expect(result.ignored).toEqual(["Frobnicate", "Read(./secrets/**)"])
  })

  test("ignores mcp__ entries that would name a built-in permission", () => {
    const result = ConfigClaude.allowedToolRules([
      "mcp__external__directory",
      "mcp__external",
      "mcp__list",
      "mcp__notebook",
      "mcp__plan",
      "mcp__bash",
      "mcp__web__fetch",
      "mcp__linear",
    ])
    expect(result.rules).toEqual([
      { permission: "web_fetch", pattern: "*", action: "allow" },
      { permission: "linear_*", pattern: "*", action: "allow" },
    ])
    expect(result.ignored).toEqual([
      "mcp__external__directory",
      "mcp__external",
      "mcp__list",
      "mcp__notebook",
      "mcp__plan",
      "mcp__bash",
    ])
  })
})
