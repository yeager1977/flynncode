import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Session } from "@/session/session"
import { SessionRetention } from "@/session/retention/service"
import { InstanceHttpApi } from "../api"
import { mapStorageNotFound } from "./session-errors"

export const sessionRetentionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session-retention", (handlers) =>
  Effect.gen(function* () {
    const retention = yield* SessionRetention.Service
    const sessions = yield* Session.Service

    return handlers
      .handle(
        "get",
        Effect.fn("SessionRetentionHttpApi.get")(function* () {
          return yield* retention.status()
        }),
      )
      .handle(
        "keep",
        Effect.fn("SessionRetentionHttpApi.keep")(function* (ctx) {
          const current = yield* mapStorageNotFound(sessions.get(ctx.params.sessionID))
          // Keep is read from the root only; sub-agent sessions follow their parent.
          if (current.parentID) return yield* new HttpApiError.BadRequest({})
          // Read, spread, set: every other metadata key (worktree bindings, folders) is kept as stored.
          const rest = Object.fromEntries(Object.entries(current.metadata ?? {}).filter(([key]) => key !== "keep"))
          yield* sessions.setMetadata({
            sessionID: current.id,
            metadata: ctx.payload.keep ? { ...rest, keep: true } : rest,
          })
          yield* SessionRetention.publishUpdated()
          return yield* mapStorageNotFound(sessions.get(current.id))
        }),
      )
  }),
)
