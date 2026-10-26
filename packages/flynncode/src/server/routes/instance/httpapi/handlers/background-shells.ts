import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { BackgroundShells } from "@/shell/background/service"
import { InstanceHttpApi } from "../api"
import { ConflictError, notFound } from "../errors"

export const backgroundShellsHandlers = HttpApiBuilder.group(InstanceHttpApi, "background-shells", (handlers) =>
  Effect.gen(function* () {
    const shells = yield* BackgroundShells.Service

    return handlers
      .handle("list", (ctx) => shells.list(ctx.params.sessionID))
      .handle(
        "output",
        Effect.fn("BackgroundShellsHttpApi.output")(function* (ctx) {
          const result = yield* shells.output({
            sessionID: ctx.params.sessionID,
            id: ctx.params.id,
            offset: ctx.query.offset ?? 0,
          })
          if (!result) return yield* notFound(`Background shell not found: ${ctx.params.id}`)
          return result
        }),
      )
      .handle(
        "stop",
        Effect.fn("BackgroundShellsHttpApi.stop")(function* (ctx) {
          const shell = yield* shells.kill({ sessionID: ctx.params.sessionID, id: ctx.params.id })
          if (!shell) return yield* notFound(`Background shell not found: ${ctx.params.id}`)
          return shell
        }),
      )
      .handle(
        "promote",
        Effect.fn("BackgroundShellsHttpApi.promote")(function* (ctx) {
          const shell = yield* shells
            .promote({ sessionID: ctx.params.sessionID, callID: ctx.payload.callID })
            .pipe(Effect.mapError((error) => new ConflictError({ message: error.message })))
          if (!shell) return yield* notFound(`No running shell call: ${ctx.payload.callID}`)
          return shell
        }),
      )
  }),
)
