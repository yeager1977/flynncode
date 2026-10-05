import { Preview } from "@/preview/preview"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PreviewApiError, StartPayload, VerifyPayload } from "../groups/preview"

export const previewHandlers = HttpApiBuilder.group(InstanceHttpApi, "preview", (handlers) =>
  Effect.gen(function* () {
    const preview = yield* Preview.Service

    const mapError = <A, R>(self: Effect.Effect<A, Preview.Error, R>) =>
      self.pipe(
        Effect.mapError((error) => new PreviewApiError({ name: error._tag, data: { message: error.message } })),
      )

    return handlers
      .handle("servers", () => preview.list())
      .handle(
        "serverStart",
        Effect.fn("PreviewHttpApi.start")(function* (ctx: { payload: typeof StartPayload.Type }) {
          return yield* mapError(preview.start(ctx.payload.name))
        }),
      )
      .handle(
        "serverStop",
        Effect.fn("PreviewHttpApi.stop")(function* (ctx: { payload: typeof StartPayload.Type }) {
          return yield* mapError(preview.stop(ctx.payload.name))
        }),
      )
      .handle(
        "serverRestart",
        Effect.fn("PreviewHttpApi.restart")(function* (ctx: { payload: typeof StartPayload.Type }) {
          return yield* mapError(preview.restart(ctx.payload.name))
        }),
      )
      .handle(
        "serverVerify",
        Effect.fn("PreviewHttpApi.verify")(function* (ctx: { payload: typeof VerifyPayload.Type }) {
          return yield* mapError(preview.verify(ctx.payload.name))
        }),
      )
  }),
)