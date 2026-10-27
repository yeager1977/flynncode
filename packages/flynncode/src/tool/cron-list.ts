import { Clock, Effect, Schema } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./cron-list.txt"
import { ScheduleStore } from "@/schedule/store"
import { Session } from "@/session/session"
import { requireRoot, when } from "./schedule/guard"

export const Parameters = Schema.Struct({})

type Metadata = { count: number }

export const CronListTool = Tool.define<typeof Parameters, Metadata, ScheduleStore.Service | Session.Service>(
  "cron_list",
  Effect.gen(function* () {
    const store = yield* ScheduleStore.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* requireRoot(sessions, ctx, ctx.sessionID)
          const jobs = yield* store.list(ctx.sessionID)
          if (jobs.length === 0)
            return { title: "0 scheduled jobs", metadata: { count: 0 }, output: "No scheduled jobs in this session." }
          const now = yield* Clock.currentTimeMillis
          return {
            title: `${jobs.length} scheduled job${jobs.length === 1 ? "" : "s"}`,
            metadata: { count: jobs.length },
            output: jobs
              .map((job) =>
                [
                  `${job.id}  ${job.kind === "wakeup" ? "wakeup" : job.recurring ? "recurring" : "one-shot"}`,
                  job.kind === "wakeup" ? `  reason: ${job.reason ?? ""}` : `  cron: ${job.cron}`,
                  `  prompt: ${job.prompt}`,
                  `  next run: ${when(job.next_run_at)}${job.next_run_at <= now ? " (due)" : ""}`,
                  ...(job.expires_at ? [`  expires: ${when(job.expires_at)}`] : []),
                ].join("\n"),
              )
              .join("\n\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
