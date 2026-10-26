import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Effect } from "effect"
import { shutdownSignal } from "../../src/cli/cmd/serve"

describe("serve shutdown", () => {
  test("SIGINT or SIGTERM ends the wait so the server shuts down through its finalizers", async () => {
    const results = await Promise.all(
      (["SIGINT", "SIGTERM"] as const).map(async (signal) => {
        const target = new EventEmitter()
        const waiting = Effect.runPromise(shutdownSignal(target))
        target.emit(signal)
        const received = await waiting
        // A second signal must still be caught (it forces the exit), not fall back to a default kill
        // that skips the process exit hooks.
        return { received, armed: target.listenerCount("SIGINT") + target.listenerCount("SIGTERM") }
      }),
    )
    expect(results).toEqual([
      { received: "SIGINT", armed: 2 },
      { received: "SIGTERM", armed: 2 },
    ])
  })
})
