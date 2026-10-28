import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { StatusLine } from "@/statusline/service"
import { InstanceHttpApi } from "../api"
import { mapStorageNotFound } from "./session-errors"

export const sessionStatusLineHandlers = HttpApiBuilder.group(InstanceHttpApi, "session-statusline", (handlers) =>
  Effect.gen(function* () {
    const statusline = yield* StatusLine.Service
    return handlers.handle(
      "get",
      Effect.fn("SessionStatusLineHttpApi.get")(function* (ctx) {
        return yield* mapStorageNotFound(statusline.get(ctx.params.sessionID))
      }),
    )
  }),
)
