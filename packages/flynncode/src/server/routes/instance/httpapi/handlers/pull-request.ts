import { Gh } from "@/git/gh"
import { InstanceState } from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PullRequestApiError } from "../groups/pull-request"

export const pullRequestHandlers = HttpApiBuilder.group(InstanceHttpApi, "pull-request", (handlers) =>
  Effect.gen(function* () {
    const gh = yield* Gh.Service

    const mapError = <A, R>(self: Effect.Effect<A, Gh.Error, R>) =>
      self.pipe(
        Effect.mapError((error) => new PullRequestApiError({ name: error._tag, data: { message: error.message } })),
      )

    return handlers
      .handle(
        "status",
        Effect.fn("PullRequestHttpApi.status")(function* () {
          const directory = yield* InstanceState.directory
          return yield* mapError(gh.prStatus(directory))
        }),
      )
      .handle(
        "merge",
        Effect.fn("PullRequestHttpApi.merge")(function* () {
          const directory = yield* InstanceState.directory
          const result = yield* mapError(gh.merge(directory))
          return result.merged
        }),
      )
  }),
)