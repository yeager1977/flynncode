import { Effect, Schema } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./cron-delete.txt"
import { ScheduleStore } from "@/schedule/store"
import { Session } from "@/session/session"
import { requireRoot } from "./schedule/guard"

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The job id from cron_create or cron_list" }),
})

type Metadata = { jobId: string; deleted: boolean }

export const CronDeleteTool = Tool.define<typeof Parameters, Metadata, ScheduleStore.Service | Session.Service>(
  "cron_delete",
  Effect.gen(function* () {
    const store = yield* ScheduleStore.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* requireRoot(sessions, ctx, ctx.sessionID)
          const deleted = yield* store.remove(ctx.sessionID, params.id)
          if (!deleted)
            return { title: `cron ${params.id}`, metadata: { jobId: params.id, deleted }, output: "no such job" }
          yield* ScheduleStore.publishUpdated({ directory: session.directory, sessionID: ctx.sessionID })
          return {
            title: `cron ${params.id}`,
            metadata: { jobId: params.id, deleted },
            output: `Deleted scheduled job ${params.id}.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
