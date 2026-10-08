import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(agentLayer())

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

it.instance("knowledge agent is a native primary agent with docs-only write", () =>
  Effect.gen(function* () {
    const knowledge = yield* load((svc) => svc.get("knowledge"))
    expect(knowledge).toBeDefined()
    expect(knowledge?.mode).toBe("primary")
    expect(knowledge?.native).toBe(true)
    expect(Permission.evaluate("edit", "*", knowledge!.permission).action).toBe("deny")
    expect(Permission.evaluate("edit", "notes.md", knowledge!.permission).action).toBe("allow")
    expect(Permission.evaluate("edit", "main.ts", knowledge!.permission).action).toBe("deny")
    expect(Permission.evaluate("write", "notes.md", knowledge!.permission).action).toBe("allow")
    expect(Permission.evaluate("write", "main.ts", knowledge!.permission).action).toBe("deny")
    expect(Permission.evaluate("webfetch", "*", knowledge!.permission).action).toBe("allow")
  }),
)
