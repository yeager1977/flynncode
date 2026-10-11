import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Agent.node, Command.node])))

it.instance("review command pins a dedicated read-only review agent", () =>
  Effect.gen(function* () {
    const command = yield* Command.Service
    const review = yield* command.get("review")
    expect(review?.agent).toBe("review")

    const agent = yield* Agent.use.get("review")
    expect(agent).toBeDefined()
    expect(agent?.mode).toBe("subagent")
    expect(Permission.evaluate("edit", "src/anything.ts", agent!.permission).action).toBe("deny")
    expect(Permission.evaluate("read", "src/anything.ts", agent!.permission).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", agent!.permission).action).toBe("allow")
  }),
)