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
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
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

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      // Update the map before anything can yield, so a busy status set while
      // a hook runs is never overwritten by this idle transition.
      if (status.type === "idle") data.delete(sessionID)
      if (status.type !== "idle") data.set(sessionID, status)
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type !== "idle") return
      yield* events.publish(Event.Idle, { sessionID })
      // Observe-only Stop hook on idle transition: detached so it never delays
      // the turn, and report-only so its context does not accumulate.
      const maybeHooks = yield* Effect.serviceOption(HooksRunner.Service)
      if (Option.isSome(maybeHooks)) {
        yield* HooksContext.observe("hooks.session.idle", maybeHooks.value.runIdle({ sessionID })).pipe(
          Effect.forkDetach,
        )
      }
      // Best-effort idle memory extraction, next to the Stop hook: forked,
      // ignored and optional so the idle transition never blocks on memory.
      const maybeCurate = yield* Effect.serviceOption(SessionMemoryCurate.Service)
      if (Option.isSome(maybeCurate)) {
        yield* maybeCurate.value.extract(sessionID).pipe(Effect.ignore, Effect.forkDetach)
      }
    })

    return Service.of({ get, list, set })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as SessionStatus from "./status"
