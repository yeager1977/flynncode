import { Clock, Effect, Schema } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./schedule-wakeup.txt"
import { ScheduleStore } from "@/schedule/store"
import { Session } from "@/session/session"
import { requireRoot, when } from "./schedule/guard"

export const MIN_DELAY_SECONDS = 60
export const MAX_DELAY_SECONDS = 3600

export const Parameters = Schema.Struct({
  delaySeconds: Schema.Finite.annotate({
    description: `Seconds until the wakeup, clamped to ${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS}`,
  }),
  prompt: Schema.String.annotate({ description: "The prompt to deliver to this session when the wakeup fires" }),
  reason: Schema.String.annotate({ description: "One short sentence on why you are waiting; shown to the user" }),
})

type Metadata = { jobId?: string; delaySeconds?: number; runAt?: number }

export const ScheduleWakeupTool = Tool.define<typeof Parameters, Metadata, ScheduleStore.Service | Session.Service>(
  "schedule_wakeup",
  Effect.gen(function* () {
    const store = yield* ScheduleStore.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* requireRoot(sessions, ctx, ctx.sessionID)
          const delaySeconds = Math.round(Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, params.delaySeconds)))
          const now = yield* Clock.currentTimeMillis
          const job = yield* store
            .create({
              sessionID: ctx.sessionID,
              kind: "wakeup",
              prompt: params.prompt,
              reason: params.reason,
              recurring: false,
              now: new Date(now),
              runAt: new Date(now + delaySeconds * 1000),
            })
            .pipe(
              Effect.catchTag("ScheduleLimitError", (error) =>
                Effect.fail(
                  new Error(
                    `This session already has ${error.limit} scheduled jobs; delete one with cron_delete before adding another`,
                  ),
                ),
              ),
              // A wakeup carries no cron.
              Effect.catchTag("ScheduleInvalidCronError", Effect.die),
            )
          yield* ScheduleStore.publishUpdated({ directory: session.directory, sessionID: ctx.sessionID })
          return {
            title: `wakeup in ${delaySeconds}s`,
            metadata: { jobId: job.id, delaySeconds, runAt: job.next_run_at },
            output: [
              `Wakeup ${job.id} scheduled in ${delaySeconds} seconds${delaySeconds === params.delaySeconds ? "" : ` (requested ${params.delaySeconds}, clamped to ${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS})`}.`,
              `Fires at: ${when(job.next_run_at)}`,
              "A new wakeup replaces any earlier pending one.",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
