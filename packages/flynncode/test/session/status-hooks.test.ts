import { expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { HooksContext } from "@/hooks/context"
import { testLayerWithHooks } from "../lib/hooks"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const release = Promise.withResolvers<void>()
const signals = { started: () => {}, done: () => {} }

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([SessionStatus.node, HooksContext.node])),
    testLayerWithHooks([
      {
        "session.idle": async (_input, output) => {
          signals.started()
          await release.promise
          output.additionalContext = "stop hook context"
          signals.done()
        },
      },
    ]),
  ),
)

it.instance("a slow Stop hook neither delays idle, clobbers a new status, nor stores context", () =>
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const store = yield* HooksContext.Service
    const sessionID = SessionID.create()
    const started = yield* Deferred.make<void>()
    const finished = yield* Deferred.make<void>()
    signals.started = () => Deferred.doneUnsafe(started, Effect.void)
    signals.done = () => Deferred.doneUnsafe(finished, Effect.void)

    yield* status.set(sessionID, { type: "busy" })
    // Returns while the Stop hook is still blocked.
    yield* awaitWithTimeout(status.set(sessionID, { type: "idle" }), "idle transition waited on the Stop hook")
    expect(yield* status.get(sessionID)).toEqual({ type: "idle" })
    yield* awaitWithTimeout(Deferred.await(started), "Stop hook never started")

    yield* status.set(sessionID, { type: "busy" })
    release.resolve()
    yield* awaitWithTimeout(Deferred.await(finished), "Stop hook never finished")

    expect(yield* status.get(sessionID)).toEqual({ type: "busy" })
    expect(yield* store.get(sessionID)).toEqual([])
  }),
)
