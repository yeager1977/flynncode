import { expect } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { HooksRunner } from "../../src/hooks/runner"
import { testLayerWithHooks } from "../lib/hooks"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import type { Hooks } from "@opencode-ai/plugin"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const askCalls: Array<Record<string, unknown>> = []
const fallthroughCalls: Array<Record<string, unknown>> = []
const toolPermissionCalls: Array<Record<string, unknown>> = []

const envWithHooks = (hooks: Array<Hooks>) =>
  AppNodeBuilder.build(
    LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [HooksRunner.node, testLayerWithHooks(hooks)],
    ],
  )

const denyEnv = envWithHooks([
  {
    "permission.ask": async (input, output) => {
      askCalls.push(input as unknown as Record<string, unknown>)
      output.status = "deny"
    },
  },
  {
    "tool.permission": async (input, output) => {
      toolPermissionCalls.push(input as unknown as Record<string, unknown>)
      output.decision = "allow"
    },
  },
])
const denyIt = testEffect(denyEnv)

const allowEnv = envWithHooks([
  {
    "permission.ask": async (input, output) => {
      fallthroughCalls.push(input as unknown as Record<string, unknown>)
      output.status = "allow"
    },
  },
])
const allowIt = testEffect(allowEnv)

const denyWinsEnv = envWithHooks([
  {
    "permission.ask": async (_input, output) => {
      output.status = "allow"
    },
  },
  {
    "permission.ask": async (_input, output) => {
      output.status = "deny"
    },
  },
])
const denyWinsIt = testEffect(denyWinsEnv)

const request = (ruleset: PermissionV1.Rule[]) => ({
  sessionID: SessionID.make("session_test"),
  permission: "bash",
  patterns: ["rm -rf build"],
  metadata: {},
  always: [],
  ruleset,
  hook: { tool: "bash", args: { command: "rm -rf build" } },
})

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const list = yield* Effect.gen(function* () {
      while (true) {
        const pending = yield* permission.list()
        if (pending.length === count) return pending
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
    return list
  })

const failOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected the effect to fail")
  })

const subscribeAsked = () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    let asked = 0
    const unsub = yield* events.listen(() => Effect.sync(() => asked++))
    yield* Effect.addFinalizer(() => unsub)
    return () => asked
  })

denyIt.instance(
  "a plugin permission.ask deny short-circuits the prompt",
  () =>
    Effect.gen(function* () {
      askCalls.length = 0
      toolPermissionCalls.length = 0
      const permission = yield* Permission.Service
      const countAsked = yield* subscribeAsked()
      const error = yield* failOf(permission.ask(request([])))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* permission.list()).toHaveLength(0)
      // The plugin ask hook runs before the PermissionRequest hook: the
      // tool.permission hook never answered, and no prompt was published.
      expect(countAsked()).toBe(0)
      expect(toolPermissionCalls).toHaveLength(0)
      expect(askCalls).toHaveLength(1)
      expect(askCalls[0]).toMatchObject({
        permission: "bash",
        patterns: ["rm -rf build"],
        sessionID: SessionID.make("session_test"),
        tool: "bash",
        args: { command: "rm -rf build" },
      })
    }),
)

denyIt.instance(
  "a config deny is evaluated before the plugin permission.ask hook",
  () =>
    Effect.gen(function* () {
      askCalls.length = 0
      toolPermissionCalls.length = 0
      const permission = yield* Permission.Service
      const error = yield* failOf(permission.ask(request([{ permission: "bash", pattern: "rm *", action: "deny" }])))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(askCalls).toHaveLength(0)
      expect(yield* permission.list()).toHaveLength(0)
    }),
)

denyWinsIt.instance(
  "a plugin permission.ask deny wins over an earlier plugin allow",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const error = yield* failOf(permission.ask(request([])))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* permission.list()).toHaveLength(0)
    }),
)

allowIt.instance(
  "a plugin permission.ask allow falls through to the pending prompt",
  () =>
    Effect.gen(function* () {
      fallthroughCalls.length = 0
      const permission = yield* Permission.Service
      const countAsked = yield* subscribeAsked()
      const fiber = yield* permission.ask(request([])).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending).toHaveLength(1)
      expect(countAsked()).toBe(1)
      expect(fallthroughCalls).toHaveLength(1)
      yield* permission.reply({ requestID: pending[0].id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
)