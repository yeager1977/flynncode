import { expect } from "bun:test"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"

// A `.claude` agent comes from a cloned repository and is untrusted. Its
// `tools` list may only take tools away: the listed ones keep exactly what the
// defaults and the user's config say. These tests evaluate the real merged
// ruleset Agent.get returns.
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

const writeAgent = (root: string, name: string, tools: string) =>
  Effect.promise(async () => {
    const file = path.join(root, ".claude", "agents", `${name}.md`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(
      file,
      ["---", `name: ${name}`, `description: ${name}`, `tools: ${tools}`, "---", "Prompt"].join("\n"),
    )
  })

const getAgent = (name: string) => Agent.Service.use((svc) => svc.get(name))

const action = (agent: Agent.Info | undefined, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, agent?.permission ?? []).action

it.instance(
  "listed tools keep the user's ask rules instead of being allowed",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeAgent(test.directory, "reviewer", "Bash, Read")
      const agent = yield* getAgent("reviewer")
      expect(action(agent, "bash", "rm -rf build")).toBe("ask")
      expect(action(agent, "read", "src/index.ts")).toBe("allow")
      expect(action(agent, "read", path.join(test.directory, ".env"))).toBe("ask")
      expect(action(agent, "read", "config/.env.local")).toBe("ask")
      expect(action(agent, "external_directory", "/somewhere/else/file")).toBe("ask")
      expect(action(agent, "edit", "src/index.ts")).toBe("deny")
      expect(action(agent, "write", "src/index.ts")).toBe("deny")
      expect(action(agent, "webfetch", "https://example.com")).toBe("deny")
      expect(action(agent, "task", "general")).toBe("deny")
      expect(action(agent, "slack_send_message")).toBe("deny")
    }),
  { git: true, config: { permission: { bash: "ask" } } },
)

it.instance(
  "listed tools keep a user deny and never gain an allow",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeAgent(test.directory, "shell", "Bash, WebFetch")
      const agent = yield* getAgent("shell")
      expect(action(agent, "bash", "git push origin dev")).toBe("deny")
      expect(action(agent, "bash", "git status")).toBe("ask")
      expect(action(agent, "webfetch", "https://example.com")).toBe("ask")
    }),
  {
    git: true,
    config: { permission: { "*": "ask", bash: { "*": "ask", "git push *": "deny" } } },
  },
)

it.instance(
  "the tools list hides only tools it does not name, MCP tools included",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeAgent(test.directory, "mcp-user", "Read, Bash, mcp__github__get_issue, mcp__linear")
      const agent = yield* getAgent("mcp-user")
      const hidden = Permission.disabled(
        [
          "read",
          "bash",
          "bash_output",
          "edit",
          "write",
          "multiedit",
          "webfetch",
          "task",
          "skill",
          "github_get_issue",
          "github_create_issue",
          "linear_create_issue",
          "slack_send_message",
        ],
        agent?.permission ?? [],
      )
      expect([...hidden].toSorted()).toEqual(
        [
          "edit",
          "github_create_issue",
          "multiedit",
          "skill",
          "slack_send_message",
          "task",
          "webfetch",
          "write",
        ].toSorted(),
      )
      expect(action(agent, "github_get_issue")).toBe("allow")
      expect(action(agent, "linear_create_issue")).toBe("allow")
      expect(action(agent, "github_create_issue")).toBe("deny")
    }),
  { git: true },
)

it.instance(
  "a listed MCP server keeps the user's ask rules for its tools",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeAgent(test.directory, "linear-user", "Read, mcp__linear")
      const agent = yield* getAgent("linear-user")
      expect(action(agent, "linear_create_issue")).toBe("ask")
      expect(action(agent, "linear_list_issues")).toBe("allow")
      expect(action(agent, "slack_send_message")).toBe("deny")
    }),
  { git: true, config: { permission: { linear_create_issue: "ask" } } },
)

it.instance(
  "NotebookEdit keeps notebook edits at the standing rule and denies other edits",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeAgent(test.directory, "notebooks", "Read, NotebookEdit")
      const agent = yield* getAgent("notebooks")
      expect(action(agent, "edit", path.join(test.directory, "analysis.ipynb"))).toBe("ask")
      expect(action(agent, "edit", path.join(test.directory, "src", "index.ts"))).toBe("deny")
      expect(Permission.disabled(["notebook_edit", "bash"], agent?.permission ?? [])).toEqual(new Set(["bash"]))
    }),
  { git: true, config: { permission: { edit: "ask" } } },
)

it.instance(
  "malformed claudeTools entries are ignored instead of crashing Agent.get",
  () =>
    Effect.gen(function* () {
      const agent = yield* getAgent("odd")
      expect(agent).toBeDefined()
      expect(action(agent, "read", "src/index.ts")).toBe("allow")
      expect(action(agent, "bash", "ls")).toBe("deny")
      expect(action(agent, "edit", "src/index.ts")).toBe("deny")
      expect(agent?.options.claudeTools).toBeUndefined()
    }),
  {
    git: true,
    config: {
      agent: {
        odd: {
          description: "odd",
          options: {
            claudeTools: [
              { permission: "bash" },
              "bash",
              null,
              { permission: 1, pattern: "*" },
              { permission: "read", pattern: "*" },
            ],
          },
        },
      },
    },
  },
)
