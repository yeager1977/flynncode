import { Auth } from "@/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Integration } from "@flynncode/core/integration"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"
import { ProviderV2 } from "@flynncode/core/provider"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const events = yield* EventV2Bridge.Service

    // Every client (other windows, the TUI, the phone) refreshes its provider lists on this event. Plugins refresh
    // tokens through authSet too; rewriting an existing entry keeps the connected set, so only a new or removed
    // entry is announced, and provider state is not rebuilt under a running request.
    const announce = (providerID: ProviderV2.ID) =>
      events.publish(Integration.Event.ConnectionUpdated, { integrationID: Integration.ID.make(providerID) })

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: Auth.Info
    }) {
      const existing = yield* auth.get(ctx.params.providerID).pipe(Effect.orDie)
      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
      if (!existing) yield* announce(ctx.params.providerID)
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      const existing = yield* auth.get(ctx.params.providerID).pipe(Effect.orDie)
      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
      if (existing) yield* announce(ctx.params.providerID)
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const write =
        ctx.payload.level === "debug"
          ? Effect.logDebug
          : ctx.payload.level === "info"
            ? Effect.logInfo
            : ctx.payload.level === "warn"
              ? Effect.logWarning
              : Effect.logError
      yield* write(ctx.payload.message).pipe(Effect.annotateLogs(ctx.payload.extra ?? {}))
      return true
    })

    return handlers.handle("authSet", authSet).handle("authRemove", authRemove).handle("log", log)
  }),
)
