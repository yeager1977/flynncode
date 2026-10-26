import { describe, expect, test } from "bun:test"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { ModelV2 } from "@flynncode/core/model"
import { ProviderV2 } from "@flynncode/core/provider"
import { Effect, Logger } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { ClaudeAlias } from "../../src/provider/claude-alias"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const model = (providerID: string, id: string, release_date: string, family?: string) => ({
  id: ModelV2.ID.make(id),
  providerID: ProviderV2.ID.make(providerID),
  release_date,
  family,
})

const providers = (...models: ReturnType<typeof model>[]) =>
  Object.fromEntries(
    Object.entries(Object.groupBy(models, (item) => item.providerID)).map(([providerID, items]) => [
      providerID,
      { models: Object.fromEntries((items ?? []).map((item) => [item.id, item])) },
    ]),
  )

describe("ClaudeAlias.resolve", () => {
  test("picks the newest connected model of the family", () => {
    const resolved = ClaudeAlias.resolve(
      "opus",
      providers(
        model("anthropic", "claude-opus-4-1", "2025-08-05", "claude-opus"),
        model("anthropic", "claude-opus-4-5", "2025-11-24", "claude-opus"),
        model("anthropic", "claude-sonnet-4-5", "2025-12-01", "claude-sonnet"),
      ),
    )
    expect(resolved).toEqual({
      providerID: ProviderV2.ID.make("anthropic"),
      modelID: ModelV2.ID.make("claude-opus-4-5"),
    })
  })

  test("falls back to the id prefix when the family is missing and ignores non-Anthropic providers", () => {
    const resolved = ClaudeAlias.resolve(
      "haiku",
      providers(
        model("openrouter", "claude-haiku-9", "2030-01-01", "claude-haiku"),
        model("vercel", "anthropic/claude-haiku-4-5", "2025-10-01"),
        model("opencode", "claude-haiku-3-5", "2024-10-22"),
      ),
    )
    expect(resolved).toEqual({
      providerID: ProviderV2.ID.make("vercel"),
      modelID: ModelV2.ID.make("anthropic/claude-haiku-4-5"),
    })
  })

  test("returns undefined for inherit and unavailable families", () => {
    const connected = providers(model("anthropic", "claude-sonnet-4-5", "2025-09-29", "claude-sonnet"))
    expect(ClaudeAlias.resolve("inherit", connected)).toBeUndefined()
    expect(ClaudeAlias.resolve("opus", connected)).toBeUndefined()
    expect(ClaudeAlias.resolve("gpt-5", connected)).toBeUndefined()
  })
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
  ),
)

const writeAgent = (directory: string, name: string, modelLine: string) =>
  Effect.promise(async () => {
    const file = path.join(directory, ".claude", "agents", `${name}.md`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, ["---", `name: ${name}`, `description: ${name} agent`, modelLine, "---", "Body"].join("\n"))
  })

const anthropicConfig = {
  provider: {
    anthropic: {
      options: { apiKey: "test-key" },
      models: {
        "claude-opus-99": { name: "Claude Opus 99", family: "claude-opus", release_date: "2099-01-01" },
      },
    },
  },
}

it.instance(
  "Agent.get resolves a Claude model alias to the newest connected model",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeAgent(test.directory, "planner", "model: opus")
      const agent = yield* Agent.use.get("planner")
      expect(agent.model).toEqual({
        providerID: ProviderV2.ID.make("anthropic"),
        modelID: ModelV2.ID.make("claude-opus-99"),
      })
      expect(agent.options.claudeModel).toBeUndefined()
    }),
  { git: true, config: anthropicConfig },
)

it.instance(
  "Agent.get leaves inherit and unresolvable aliases on the session model",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeAgent(test.directory, "inheritor", "model: inherit")
      yield* writeAgent(test.directory, "orphan", "model: haiku")
      expect((yield* Agent.use.get("inheritor")).model).toBeUndefined()
      expect((yield* Agent.use.get("orphan")).model).toBeUndefined()
    }),
  { git: true },
)

const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const messages: unknown[] = []
  return effect.pipe(
    Effect.provide(
      Logger.layer([
        Logger.make<unknown, void>((options) => {
          messages.push(options.message)
        }),
      ]),
    ),
    Effect.map((value) => ({ value, messages: messages.map((item) => JSON.stringify(item)) })),
  )
}

it.instance(
  "a same-named Claude agent leaves a built-in agent untouched and warns once",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(async () => {
        const file = path.join(test.directory, ".claude", "agents", "explore.md")
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(
          file,
          [
            "---",
            "name: explore",
            "description: impostor",
            "tools: Read",
            "model: opus",
            "---",
            "Impostor prompt",
          ].join("\n"),
        )
      })
      const logged = yield* captureLogs(Agent.use.get("explore"))
      const explore = logged.value
      expect(explore.native).toBe(true)
      expect(explore.mode).toBe("subagent")
      expect(explore.prompt).not.toContain("Impostor")
      expect(explore.description).not.toBe("impostor")
      expect(explore.permission.some((rule) => rule.permission === "grep" && rule.action === "allow")).toBe(true)
      expect(explore.options.claudeSource).toBeUndefined()
      expect(
        logged.messages.filter((item) => item.includes("explore") && item.includes("a built-in agent has that name")),
      ).toHaveLength(1)
    }),
  { git: true },
)

it.instance(
  "an unresolved Claude model alias warns once per agent",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeAgent(test.directory, "orphan", "model: haiku")
      const logged = yield* captureLogs(
        Effect.gen(function* () {
          yield* Agent.use.get("orphan")
          yield* Agent.use.get("orphan")
          return yield* Agent.use.get("orphan")
        }),
      )
      expect(logged.messages.filter((item) => item.includes("has no connected Anthropic model"))).toHaveLength(1)
    }),
  { git: true },
)
