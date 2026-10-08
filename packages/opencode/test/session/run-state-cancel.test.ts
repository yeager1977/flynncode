import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { testEffect } from "../lib/effect"

const received: SessionID[] = []

const executionStub = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: (sessionID) =>
      Effect.sync(() => {
        received.push(sessionID)
      }),
  }),
)

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([SessionRunState.node, SessionStatus.node])),
    executionStub,
  ),
)

describe("run-state cancel", () => {
  it.instance("interrupts the V2 drain and idles a session with no runner", () =>
    Effect.gen(function* () {
      const state = yield* SessionRunState.Service
      const status = yield* SessionStatus.Service
      received.length = 0
      const sessionID = SessionID.create()
      yield* state.cancel(sessionID)
      expect(received).toEqual([sessionID])
      expect(yield* status.get(sessionID)).toEqual({ type: "idle" })
    }),
  )
})
