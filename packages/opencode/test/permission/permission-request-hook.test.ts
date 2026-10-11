import { expect } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { HooksRunner } from "../../src/hooks/runner"
import { testLayerWithHooks } from "../lib/hooks"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

const calls: { tool: string; args: unknown }[] = []
const allowEverything = testLayerWithHooks([
  {
    "tool.permission": async (input, output) => {
      calls.push({ tool: input.tool, args: input.args })
      output.decision = "allow"
    },
  },
])
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [HooksRunner.node, allowEverything],
    ],
  ),
)

const request = (ruleset: PermissionV1.Rule[]) => ({
  sessionID: SessionID.make("session_test"),
  permission: "bash",
  patterns: ["rm -rf build"],
  metadata: {},
  always: [],
  ruleset,
  hook: { tool: "bash", args: { command: "rm -rf build" } },
})

it.instance("a config deny wins over a PermissionRequest hook allow", () =>
  Effect.gen(function* () {
    calls.length = 0
    const permission = yield* Permission.Service
    const exit = yield* Effect.exit(
      permission.ask(request([{ permission: "bash", pattern: "rm *", action: "deny" }])),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
    expect(calls).toHaveLength(0)
  }),
)

it.instance("the PermissionRequest hook is skipped when no prompt would be shown", () =>
  Effect.gen(function* () {
    calls.length = 0
    const permission = yield* Permission.Service
    yield* permission.ask(request([{ permission: "bash", pattern: "*", action: "allow" }]))
    // Auto approval only short-circuits on an LLM reviewer allow verdict;
    // without one the request reaches the hooks and the user.
    yield* permission.ask({ ...request([]), approval: "auto", reviewer: "allow" })
    expect(calls).toHaveLength(0)
  }),
)

it.instance("the PermissionRequest hook answers a prompt with the real tool args", () =>
  Effect.gen(function* () {
    calls.length = 0
    const permission = yield* Permission.Service
    yield* permission.ask(request([]))
    expect(yield* permission.list()).toHaveLength(0)
    expect(calls).toEqual([{ tool: "bash", args: { command: "rm -rf build" } }])
  }),
)
