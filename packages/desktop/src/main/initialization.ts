import { Deferred, Effect, Fiber } from "effect"

export function forwardInitializationFailure<A>(initialization: Deferred.Deferred<A, unknown>) {
  return <B, E, R>(effect: Effect.Effect<B, E, R>) =>
    effect.pipe(Effect.tapCause((cause) => Deferred.failCause(initialization, cause)))
}

// Windows open while the server loads: the renderer's splash waits on initialization, so nothing visible
// depends on the sidecar having started. The load still has to be awaited, since a forked child is
// interrupted when its parent finishes.
export function openBeforeServer<E, R>(input: { load: Effect.Effect<void, E, R>; open: () => void }) {
  return Effect.gen(function* () {
    const loading = yield* Effect.forkChild(input.load)
    input.open()
    return yield* Fiber.await(loading)
  })
}
