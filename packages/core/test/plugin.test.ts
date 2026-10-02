import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { define } from "@opencode-ai/plugin/v2/effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { EventV2 } from "@opencode-ai/core/event"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { State } from "@opencode-ai/core/state"
import { testEffect } from "./lib/effect"
import { PluginTestLayer, PluginTestLayerWithEvent } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
const itEventPublishFails = testEffect(
  PluginTestLayerWithEvent(
    Layer.mock(EventV2.Service)({
      publish: () => Effect.die("event publication failed"),
    }),
  ),
)

describe("PluginV2", () => {
  it.effect("waits for a plugin and returns immediately once active", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("waited")
      const waiting = yield* plugins.wait(id).pipe(Effect.forkChild)

      yield* plugins.add(id, () => Effect.void)
      yield* Fiber.join(waiting)
      yield* plugins.wait(id)
    }),
  )

  it.effect("waiters observe state transforms after a nested batch reload", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const id = PluginV2.ID.make("nested-batch")
      const waiting = yield* plugins
        .wait(id)
        .pipe(Effect.andThen(agents.get(AgentV2.ID.make("configured"))), Effect.forkChild)

      yield* State.batch(
        Effect.gen(function* () {
          yield* plugins.add(id, (ctx) =>
            ctx.agent
              .transform((draft) =>
                draft.update("configured", (agent) => {
                  agent.description = "ready"
                }),
              )
              .pipe(Effect.asVoid),
          )
          yield* Effect.yieldNow
        }),
      )

      expect((yield* Fiber.join(waiting))?.description).toBe("ready")
    }),
  )

  it.effect("runs later after-batch callbacks when an earlier callback defects", () =>
    Effect.gen(function* () {
      let ran = false
      const result = yield* State.batch(
        Effect.gen(function* () {
          yield* State.afterBatch(() => Effect.die("after-batch failure"))
          yield* State.afterBatch(() => Effect.sync(() => (ran = true)))
        }),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(ran).toBe(true)
    }),
  )

  itEventPublishFails.live("rejects plugin waiters when its added event fails", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const id = PluginV2.ID.make("event-fails")
      const waiting = yield* plugins.wait(id).pipe(Effect.exit, Effect.forkChild)
      const added = yield* plugins
        .add(id, (ctx) =>
          ctx.agent
            .transform((draft) =>
              draft.update("configured", (agent) => {
                agent.description = "not active"
              }),
            )
            .pipe(Effect.asVoid),
        )
        .pipe(Effect.exit)
      const pending = yield* Fiber.join(waiting)

      expect(Exit.isFailure(added)).toBe(true)
      expect(Exit.isFailure(pending)).toBe(true)
      expect(yield* agents.get(AgentV2.ID.make("configured"))).toBeUndefined()
    }),
  )

  it.effect("propagates plugin activation defects to waiters", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("failed")
      const waiting = yield* plugins.wait(id).pipe(Effect.exit, Effect.forkChild)

      const added = yield* plugins.add(id, () => Effect.die("boom")).pipe(Effect.exit)
      const pending = yield* Fiber.join(waiting)
      const later = yield* plugins.wait(id).pipe(Effect.exit)

      expect(Exit.isFailure(added)).toBe(true)
      expect(Exit.isFailure(pending)).toBe(true)
      expect(Exit.isFailure(later)).toBe(true)
    }),
  )

  it.effect("adds, replaces, and removes plugins", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      let description = "first"

      const managed = () =>
        define({
          id: "managed",
          effect: (ctx) =>
            ctx.agent
              .transform((agents) =>
                agents.update("configured", (agent) => {
                  agent.description = description
                }),
              )
              .pipe(Effect.asVoid),
        })

      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)

      expect((yield* agents.get(AgentV2.ID.make("configured")))?.description).toBe("first")

      description = "second"
      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)
      expect((yield* agents.get(AgentV2.ID.make("configured")))?.description).toBe("second")

      yield* plugins.remove(PluginV2.ID.make("managed"))
      expect(yield* agents.get(AgentV2.ID.make("configured"))).toBeUndefined()
    }),
  )
})
