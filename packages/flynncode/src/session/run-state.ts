import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionExecution } from "@flynncode/core/session/execution"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { SessionV1 } from "@flynncode/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Option, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  // A step moved the session's folder and its turn goes on in the current
  // instance: the session reads busy here until the turn ends, while the
  // turn's runner stays in the instance the turn started in.
  readonly follow: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    // Process-wide, by session: the instance whose runner runs the session's
    // turn, and the other instance that turn moved the session to. Every call
    // for a session reaches its runner through `owners`, whichever folder the
    // caller addresses the session by, so a moved session never runs twice.
    const owners = new Map<SessionID, InstanceContext>()
    const guests = new Map<SessionID, InstanceContext>()

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        // Sessions being cancelled, whose idle transition is an interrupt.
        const cancelling = new Set<SessionID>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            for (const sessionID of runners.keys())
              if (owners.get(sessionID)?.directory === ctx.directory) owners.delete(sessionID)
            runners.clear()
          }),
        )
        return { runners, cancelling, scope }
      }),
    )

    // Runs `effect` in the instance that owns the session's runner, if any.
    const inOwner = <A, E, R>(sessionID: SessionID, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const owner = owners.get(sessionID)
        return owner ? effect.pipe(Effect.provideService(InstanceRef, owner)) : effect
      })

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const ctx = yield* InstanceState.context
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const here = <A>(effect: Effect.Effect<A>) => effect.pipe(Effect.provideService(InstanceRef, ctx))
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          if (owners.get(sessionID)?.directory === ctx.directory) owners.delete(sessionID)
          const guest = guests.get(sessionID)
          guests.delete(sessionID)
          const interrupted = data.cancelling.has(sessionID)
          if (!guest) return yield* here(status.set(sessionID, { type: "idle" }, { interrupted }))
          // The turn ended in another folder: the session goes idle where it
          // now lives, and only drops its busy status where the turn started.
          yield* here(status.set(sessionID, { type: "idle" }, { quiet: true }))
          yield* status
            .set(sessionID, { type: "idle" }, { interrupted })
            .pipe(Effect.provideService(InstanceRef, guest))
        }),
        onBusy: here(status.set(sessionID, { type: "busy" })),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      owners.set(sessionID, ctx)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* inOwner(sessionID, InstanceState.get(state))
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      // Background work belongs to the instance it started in, which for a
      // moved session can be any folder its turn ran in.
      const places = [yield* InstanceState.context, owners.get(sessionID), guests.get(sessionID)].filter(
        (ctx, index, all): ctx is InstanceContext =>
          ctx !== undefined && all.findIndex((other) => other?.directory === ctx.directory) === index,
      )
      yield* Effect.forEach(
        places,
        (ctx) => cancelBackgroundJobs(background, sessionID).pipe(Effect.provideService(InstanceRef, ctx)),
        { discard: true },
      )
      const execution = yield* Effect.serviceOption(SessionExecution.Service)
      if (Option.isSome(execution)) yield* execution.value.interrupt(sessionID)
      const data = yield* inOwner(sessionID, InstanceState.get(state))
      const existing = data.runners.get(sessionID)
      if (!existing) {
        yield* status.set(sessionID, { type: "idle" }, { interrupted: true })
        return
      }
      data.cancelling.add(sessionID)
      yield* existing.cancel.pipe(Effect.ensuring(Effect.sync(() => data.cancelling.delete(sessionID))))
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* inOwner(
        sessionID,
        runner(sessionID, onInterrupt).pipe(Effect.flatMap((next) => next.ensureRunning(work))),
      )
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* inOwner(
        sessionID,
        runner(sessionID, onInterrupt).pipe(
          Effect.flatMap((next) => next.startShell(work, ready)),
          Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))),
        ),
      )
    })

    const follow = Effect.fn("SessionRunState.follow")(function* (sessionID: SessionID) {
      const ctx = yield* InstanceState.context
      const owner = owners.get(sessionID)
      const previous = guests.get(sessionID)
      if (previous && previous.directory !== ctx.directory)
        yield* status
          .set(sessionID, { type: "idle" }, { quiet: true })
          .pipe(Effect.provideService(InstanceRef, previous))
      if (owner === undefined || owner.directory === ctx.directory) guests.delete(sessionID)
      if (owner !== undefined && owner.directory !== ctx.directory) guests.set(sessionID, ctx)
      yield* status.set(sessionID, { type: "busy" })
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell, follow })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node] })

export * as SessionRunState from "./run-state"
