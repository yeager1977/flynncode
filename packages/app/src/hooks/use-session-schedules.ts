import { createEffect, createSignal, on, onCleanup } from "solid-js"
import type { SessionSchedule } from "@flynncode/sdk/v2/client"
import { useSDK } from "@/context/sdk"

export type ScheduleClient = {
  session: {
    schedules: {
      delete: (input: { sessionID: string; jobID: string }) => Promise<{ data?: boolean }>
    }
  }
}

export type ScheduleRow = {
  id: string
  kind: SessionSchedule["kind"]
  // A cron job's expression or a wakeup's reason.
  detail: string
  prompt: string
  recurring: boolean
  due: boolean
  remainingMs: number
}

export function useSessionSchedules(sessionID: () => string | undefined) {
  const sdk = useSDK()
  const [jobs, setJobs] = createSignal<SessionSchedule[]>([])
  // A newer request or a session switch invalidates in-flight lists, so a slow
  // response cannot overwrite a fresher one or another session's jobs.
  let generation = 0

  const refresh = async () => {
    const id = sessionID()
    if (!id) return
    const run = ++generation
    const result = await sdk()
      .client.session.schedules.list({ sessionID: id })
      .catch(() => undefined)
    if (!result || run !== generation || id !== sessionID()) return
    setJobs(result.data ?? [])
  }

  const cancel = async (jobID: string) => {
    const id = sessionID()
    if (!id) return false
    const ok = await cancelSchedule(sdk().client, id, jobID)
    void refresh()
    return ok
  }

  createEffect(
    on(sessionID, (id) => {
      generation++
      setJobs([])
      if (id) void refresh()
    }),
  )

  createEffect(() => {
    const off = sdk().event.on("session.schedule.updated", (event) => {
      if (event.properties.sessionID === sessionID()) void refresh()
    })
    onCleanup(off)
  })

  return { jobs, refresh, cancel }
}

export async function cancelSchedule(client: ScheduleClient, sessionID: string, jobID: string) {
  const result = await client.session.schedules.delete({ sessionID, jobID }).catch(() => undefined)
  return result?.data === true
}

export function scheduleChipCount(jobs: readonly SessionSchedule[]) {
  return jobs.length
}

// The server lists soonest first; sorting here keeps rows stable if that order ever changes.
export function scheduleRows(jobs: readonly SessionSchedule[], now: number): ScheduleRow[] {
  return jobs
    .toSorted((a, b) => a.nextRunAt - b.nextRunAt || a.id.localeCompare(b.id))
    .map((job) => ({
      id: job.id,
      kind: job.kind,
      detail: (job.kind === "cron" ? job.cron : job.reason) ?? "",
      prompt: job.prompt,
      recurring: job.recurring,
      due: job.nextRunAt <= now,
      remainingMs: Math.max(0, job.nextRunAt - now),
    }))
}
