import { LayerNode } from "@flynncode/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Option } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@flynncode/schema/session-status-event"
import { HooksRunner } from "@/hooks/runner"
import { HooksContext } from "@/hooks/context"
import { SessionMemoryCurate } from "./memory-curate"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  // `interrupted` marks an idle transition caused by a cancel or an aborted
  // turn, which the user just asked for, so it does not notify them that the
  // session is waiting.
  readonly set: (sessionID: SessionID, status: Info, options?: { interrupted?: boolean }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

    const set = Effect.fn("SessionStatus.set")(function* (
      sessionID: SessionID,
      status: Info,
      options?: { interrupted?: boolean },
    ) {
      const data = yield* InstanceState.get(state)
      // Update the map before anything can yield, so a busy status set while
      // a hook runs is never overwritten by this idle transition.
      if (status.type === "idle") data.delete(sessionID)
      if (status.type !== "idle") data.set(sessionID, status)
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type !== "idle") return
      yield* events.publish(Event.Idle, { sessionID })
      // The observe-only session.idle plugin hook: detached so it never delays
      // the turn, and report-only so its context does not accumulate. The Stop
      // event runs earlier, blocking, at the end of the prompt loop.
      const maybeHooks = yield* Effect.serviceOption(HooksRunner.Service)
      if (Option.isSome(maybeHooks)) {
        yield* HooksContext.observe("hooks.session.idle", maybeHooks.value.runIdle({ sessionID })).pipe(
          Effect.forkDetach,
        )
        if (!options?.interrupted) yield* notifyIdle(maybeHooks.value, sessionID).pipe(Effect.forkDetach)
      }
      // Best-effort idle memory extraction, next to the idle hook: forked,
      // ignored and optional so the idle transition never blocks on memory.
      const maybeCurate = yield* Effect.serviceOption(SessionMemoryCurate.Service)
      if (Option.isSome(maybeCurate)) {
        yield* maybeCurate.value.extract(sessionID).pipe(Effect.ignore, Effect.forkDetach)
      }
    })

    return Service.of({ get, list, set })
  }),
)

// Notification "idle" is for the user waiting on a root session; a child
// session going idle hands control back to its parent, not to the user.
// Session.Service comes from the caller's context (dynamic import: the session
// module sits above this one).
const notifyIdle = (hooks: HooksRunner.RunnerInterface, sessionID: SessionID) =>
  Effect.gen(function* () {
    const { Session } = yield* Effect.promise(() => import("./session"))
    const sessions = yield* Effect.serviceOption(Session.Service)
    if (Option.isNone(sessions)) return
    const info = yield* sessions.value.get(sessionID)
    if (info.parentID) return
    yield* hooks.runNotification({ sessionID, message: "Flynncode is waiting for your input", type: "idle" })
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("idle notification failed", { sessionID, cause })))

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as SessionStatus from "./status"
