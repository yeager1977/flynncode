import type { EventEmitter } from "node:events"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@flynncode/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    const signal = yield* shutdownSignal(process)
    console.log(`opencode server received ${signal}; shutting down`)
    // Closing the listener runs the server's finalizers (background shells are killed there); returning lets the
    // CLI entry point exit the process.
    yield* Effect.promise(() => server.stop(true))
  }),
})

// Without a handler, SIGINT/SIGTERM end the process at once: no finalizer runs and not even the process "exit"
// listeners fire, so background shells would be orphaned. The first signal starts the normal shutdown; a second one
// forces the exit (the "exit" listeners still signal any background shell left).
export function shutdownSignal(target: EventEmitter) {
  return Effect.callback<NodeJS.Signals>((resume) => {
    const signals = ["SIGINT", "SIGTERM"] as const
    const state = { received: false }
    const onSignal = (signal: NodeJS.Signals) => {
      if (state.received) return process.exit(1)
      state.received = true
      resume(Effect.succeed(signal))
    }
    signals.forEach((signal) => target.on(signal, () => onSignal(signal)))
  })
}
