import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ScheduleStore } from "@/schedule/store"
import { Session } from "@/session/session"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"

export const sessionSchedulesHandlers = HttpApiBuilder.group(InstanceHttpApi, "session-schedules", (handlers) =>
  Effect.gen(function* () {
    const store = yield* ScheduleStore.Service
    const sessions = yield* Session.Service

    return handlers
      .handle(
        "list",
        Effect.fn("SessionSchedulesHttpApi.list")(function* (ctx) {
          const jobs = yield* store.list(ctx.params.sessionID)
          return jobs.map((job) => ({
            id: job.id,
            kind: job.kind,
            cron: job.cron ?? undefined,
            prompt: job.prompt,
            reason: job.reason ?? undefined,
            recurring: job.recurring,
            nextRunAt: job.next_run_at,
            expiresAt: job.expires_at ?? undefined,
          }))
        }),
      )
      .handle(
        "delete",
        Effect.fn("SessionSchedulesHttpApi.delete")(function* (ctx) {
          if (!(yield* store.remove(ctx.params.sessionID, ctx.params.jobID)))
            return yield* notFound(`Scheduled prompt not found: ${ctx.params.jobID}`)
          // The job is gone either way; the event only needs the session's directory.
          const session = yield* sessions.get(ctx.params.sessionID).pipe(Effect.option)
          if (session._tag === "Some")
            yield* ScheduleStore.publishUpdated({ directory: session.value.directory, sessionID: session.value.id })
          return true
        }),
      )
  }),
)
