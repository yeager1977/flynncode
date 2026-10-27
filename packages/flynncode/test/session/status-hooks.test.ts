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
          output.additionalContext = "idle hook context"
          signals.done()
        },
      },
    ]),
  ),
)

// The session.idle plugin hook still runs detached on idle. The Stop event no
// longer does: it runs blocking at the end of the prompt loop (stop-hooks.test.ts).
it.instance("a slow session.idle hook neither delays idle, clobbers a new status, nor stores context", () =>
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const store = yield* HooksContext.Service
    const sessionID = SessionID.create()
    const started = yield* Deferred.make<void>()
    const finished = yield* Deferred.make<void>()
    signals.started = () => Deferred.doneUnsafe(started, Effect.void)
    signals.done = () => Deferred.doneUnsafe(finished, Effect.void)

    yield* status.set(sessionID, { type: "busy" })
    // Returns while the session.idle hook is still blocked.
    yield* awaitWithTimeout(status.set(sessionID, { type: "idle" }), "idle transition waited on the session.idle hook")
    expect(yield* status.get(sessionID)).toEqual({ type: "idle" })
    yield* awaitWithTimeout(Deferred.await(started), "session.idle hook never started")

    yield* status.set(sessionID, { type: "busy" })
    release.resolve()
    yield* awaitWithTimeout(Deferred.await(finished), "session.idle hook never finished")

    expect(yield* status.get(sessionID)).toEqual({ type: "busy" })
    expect(yield* store.get(sessionID)).toEqual([])
  }),
)
