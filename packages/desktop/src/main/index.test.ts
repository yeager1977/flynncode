import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { forwardInitializationFailure, openBeforeServer } from "./initialization"

describe("desktop initialization", () => {
  const failure = new Error("sidecar startup failed")
  const expectFailure = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.squash(exit.cause)).toBe(failure)
  }

  test("forwards loading task failures before renderer initialization", () => {
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        return yield* Deferred.await(initialization).pipe(Effect.exit)
      }),
    )

    expectFailure(exit)
  })

  test("forwards loading task failures while renderer initialization waits", () => {
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        const waiting = yield* Deferred.await(initialization).pipe(Effect.exit, Effect.forkChild)
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        return yield* Fiber.join(waiting)
      }),
    )

    expectFailure(exit)
  })

  test("opens windows before the server has loaded", async () => {
    const events: string[] = []
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* Deferred.make<void>()
        const startup = yield* openBeforeServer({
          load: Deferred.await(server).pipe(Effect.tap(() => Effect.sync(() => events.push("server ready")))),
          open: () => events.push("windows open"),
        }).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        events.push("server starting")
        yield* Deferred.succeed(server, undefined)
        return yield* Fiber.join(startup)
      }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(events).toEqual(["windows open", "server starting", "server ready"])
  })

  test("reports a server failure to windows that are already open", () => {
    const events: string[] = []
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        const startup = yield* openBeforeServer({
          load: Effect.die(failure).pipe(forwardInitializationFailure(initialization)),
          open: () => events.push("windows open"),
        })
        expect(Exit.isFailure(startup)).toBe(true)
        return yield* Deferred.await(initialization).pipe(Effect.exit)
      }),
    )

    expect(events).toEqual(["windows open"])
    expectFailure(exit)
  })
})
