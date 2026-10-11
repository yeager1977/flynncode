import { ComputerUseExecutor } from "@/computer-use"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const computerUseHandlers = HttpApiBuilder.group(InstanceHttpApi, "computer-use", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* ComputerUseExecutor.Service

    const requests = Effect.fn("ComputerUseHttpApi.requests")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("ComputerUseHttpApi.reply")(function* (ctx: { payload: ComputerUseExecutor.Reply }) {
      yield* svc.reply(ctx.payload.requestID, ctx.payload.result)
      return true
    })

    return handlers.handle("requests", requests).handle("reply", reply)
  }),
)