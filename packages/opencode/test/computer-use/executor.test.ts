import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber, Layer, Queue, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ComputerUseV1 } from "@opencode-ai/schema/computer-use-v1"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ComputerUseExecutor } from "../../src/computer-use"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const computerUseLayer = LayerNode.compile(
  LayerNode.group([ComputerUseExecutor.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
)
const it = testEffect(computerUseLayer)

const screenshotRequest: ComputerUseExecutor.ExecuteRequest = {
  sessionID: SessionID.make("ses_test"),
  action: "screenshot",
  appID: "com.example.gui",
}

/** Subscribes to the executor bridge's published requests (EventV2Bridge listener). */
const requested = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const queue = yield* Queue.unbounded<unknown>()
  const off = yield* events.listen((event) => {
    if (event.type === ComputerUseV1.Event.Requested.type) Queue.offerUnsafe(queue, event.data)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  return queue
})

afterEach(async () => {
  await disposeAllInstances()
})

it.effect(
  "executes via the bridge when a client replies",
  () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const executor = yield* ComputerUseExecutor.Service
        const queue = yield* requested

        const fiber = yield* executor.execute(screenshotRequest).pipe(Effect.forkScoped)

        const raw = yield* awaitWithTimeout(Queue.take(queue), "computer-use request was never published")
        const published = Schema.decodeUnknownSync(ComputerUseV1.Event.Requested.data)(raw)
        expect(published.action).toBe("screenshot")
        expect(published.appID).toBe("com.example.gui")
        expect(published.sessionID).toBe(SessionID.make("ses_test"))
        expect(published.time).toBeGreaterThan(0)
        expect(yield* executor.list()).toEqual([published])

        const result: ComputerUseExecutor.Result = { ok: true, screenshot: "data:image/png;base64,AAAA" }
        yield* executor.reply(published.requestID, result)
        expect(yield* Fiber.join(fiber)).toEqual(result)
        expect(yield* executor.list()).toEqual([])
      }),
    ),
)

it.effect(
  "times out to ComputerUseExecutorUnavailableError when no client answers",
  () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const executor = yield* ComputerUseExecutor.Service
        const queue = yield* requested

        const fiber = yield* executor.execute(screenshotRequest).pipe(Effect.forkScoped)

        // Barrier: the executor is parked on its deferred once the request is
        // published and pending; only then may the gate time advance.
        yield* awaitWithTimeout(Queue.take(queue), "computer-use request was never published")
        yield* TestClock.adjust(ComputerUseExecutor.BRIDGE_TIMEOUT)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(ComputerUseExecutor.ComputerUseExecutorUnavailableError)
        }
        // A timed-out request must be treated as never having happened.
        expect(yield* executor.list()).toEqual([])
      }),
    ),
)

it.effect(
  "reply for an unknown request is a no-op",
  () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const executor = yield* ComputerUseExecutor.Service
        // A late reply after the request timed out or from another instance
        // resolves nothing and must not fail the caller.
        yield* executor.reply(ComputerUseV1.ID.ascending(), { ok: true })
        expect(yield* executor.list()).toEqual([])
      }),
    ),
)