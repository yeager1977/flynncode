import { WorktreeJanitor } from "@/worktree/janitor/janitor"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { WorktreeCleanupRemoveInput } from "../groups/worktree-cleanup"

export const worktreeCleanupHandlers = HttpApiBuilder.group(RootHttpApi, "worktreeCleanup", (handlers) =>
  Effect.gen(function* () {
    const janitor = yield* WorktreeJanitor.Service

    const report = Effect.fn("WorktreeCleanupHttpApi.report")(function* () {
      return yield* janitor.report()
    })

    const scan = Effect.fn("WorktreeCleanupHttpApi.scan")(function* () {
      return yield* janitor.scan()
    })

    const remove = Effect.fn("WorktreeCleanupHttpApi.remove")(function* (ctx: {
      payload: typeof WorktreeCleanupRemoveInput.Type
    }) {
      return { results: yield* janitor.remove([...ctx.payload.paths]) }
    })

    return handlers.handle("report", report).handle("scan", scan).handle("remove", remove)
  }),
)
