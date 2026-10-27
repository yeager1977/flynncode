import { Clock, Effect, Schema } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./cron-create.txt"
import { ScheduleStore } from "@/schedule/store"
import { Session } from "@/session/session"
import { requireRoot, when } from "./schedule/guard"

export const Parameters = Schema.Struct({
  cron: Schema.String.annotate({
    description:
      'Standard 5-field cron expression (minute hour day-of-month month day-of-week) in the server\'s local time zone, e.g. "*/5 * * * *"',
  }),
  prompt: Schema.String.annotate({ description: "The prompt to deliver to this session at each fire time" }),
  recurring: Schema.optional(Schema.Boolean).annotate({
    description:
      "true (default) fires at every match until deleted or after 7 days; false fires once at the next match",
  }),
})

type Metadata = { jobId?: string; nextRunAt?: number }

export const CronCreateTool = Tool.define<typeof Parameters, Metadata, ScheduleStore.Service | Session.Service>(
  "cron_create",
  Effect.gen(function* () {
    const store = yield* ScheduleStore.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* requireRoot(sessions, ctx, ctx.sessionID)
          const recurring = params.recurring ?? true
          const job = yield* store
            .create({
              sessionID: ctx.sessionID,
              kind: "cron",
              cron: params.cron.trim(),
              prompt: params.prompt,
              recurring,
              now: new Date(yield* Clock.currentTimeMillis),
            })
            .pipe(
              Effect.catchTag("ScheduleInvalidCronError", () =>
                Effect.fail(
                  new Error(
                    `Invalid cron expression "${params.cron}": use 5 fields (minute hour day-of-month month day-of-week), e.g. "*/5 * * * *"`,
                  ),
                ),
              ),
              Effect.catchTag("ScheduleLimitError", (error) =>
                Effect.fail(
                  new Error(
                    `This session already has ${error.limit} scheduled jobs; delete one with cron_delete before adding another`,
                  ),
                ),
              ),
            )
          yield* ScheduleStore.publishUpdated({ directory: session.directory, sessionID: ctx.sessionID })
          return {
            title: `cron ${job.id}`,
            metadata: { jobId: job.id, nextRunAt: job.next_run_at },
            output: [
              `Scheduled job ${job.id}: ${params.cron.trim()} (${recurring ? "recurring" : "one-shot"}).`,
              `Next run: ${when(job.next_run_at)}`,
              ...(job.expires_at ? [`Expires: ${when(job.expires_at)}`] : []),
              "Use cron_list to see scheduled jobs and cron_delete to cancel one.",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
