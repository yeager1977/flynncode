import { describe, expect, test } from "bun:test"
import type { SessionSchedule } from "@flynncode/sdk/v2/client"
import { cancelSchedule, scheduleChipCount, scheduleRows, type ScheduleClient } from "@/hooks/use-session-schedules"
import { scheduleContinuation } from "@/pages/session/timeline/schedule-divider"
import { dict } from "@/i18n/en"

const job = (id: string, extra: Partial<SessionSchedule> = {}): SessionSchedule => ({
  id,
  kind: "cron",
  cron: "*/5 * * * *",
  prompt: "check the build",
  recurring: true,
  nextRunAt: 100_000,
  ...extra,
})

describe("scheduleChipCount", () => {
  test("counts every job, cron or wakeup, and is zero for an empty list", () => {
    expect(scheduleChipCount([])).toBe(0)
    expect(scheduleChipCount([job("sch_1"), job("sch_2", { kind: "wakeup", reason: "CI" })])).toBe(2)
  })

  test("the chip copy reads as the spec's clock chip", () => {
    expect(dict["session.schedules.chip"]).toBe("{{count}} scheduled")
  })
})

describe("scheduleRows", () => {
  test("orders by next run and describes a cron job by its expression", () => {
    const rows = scheduleRows(
      [job("sch_b", { nextRunAt: 300_000 }), job("sch_a", { nextRunAt: 200_000, recurring: false })],
      150_000,
    )
    expect(rows.map((row) => row.id)).toEqual(["sch_a", "sch_b"])
    expect(rows[0]).toEqual({
      id: "sch_a",
      kind: "cron",
      detail: "*/5 * * * *",
      prompt: "check the build",
      recurring: false,
      due: false,
      remainingMs: 50_000,
    })
  })

  test("describes a wakeup by its reason and marks a past run as due", () => {
    const [row] = scheduleRows([job("sch_w", { kind: "wakeup", cron: undefined, reason: "waiting for CI" })], 500_000)
    expect(row).toMatchObject({ kind: "wakeup", detail: "waiting for CI", due: true, remainingMs: 0 })
  })

  test("falls back to an empty detail when the server sent none", () => {
    const [row] = scheduleRows([job("sch_x", { kind: "wakeup", cron: undefined })], 0)
    expect(row.detail).toBe("")
  })
})

describe("cancelSchedule", () => {
  const client = (result: unknown) => {
    const calls: unknown[] = []
    const value: ScheduleClient = {
      session: {
        schedules: {
          delete: async (input) => {
            calls.push(input)
            if (result instanceof Error) throw result
            return result as { data?: boolean }
          },
        },
      },
    }
    return { value, calls }
  }

  test("sends a DELETE for exactly the session and job, and reports success", async () => {
    const { value, calls } = client({ data: true })
    expect(await cancelSchedule(value, "ses_1", "sch_1")).toBe(true)
    expect(calls).toEqual([{ sessionID: "ses_1", jobID: "sch_1" }])
  })

  test("reports failure when the request rejects or returns nothing", async () => {
    expect(await cancelSchedule(client(new Error("offline")).value, "ses_1", "sch_1")).toBe(false)
    expect(await cancelSchedule(client({}).value, "ses_1", "sch_1")).toBe(false)
  })
})

describe("scheduled prompt divider", () => {
  const part = (metadata?: Record<string, unknown>) => ({
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text" as const,
    text: "check the build",
    synthetic: true,
    ...(metadata && { metadata }),
  })

  test("reads the cron expression of a scheduled prompt", () => {
    expect(scheduleContinuation([part({ schedule: { id: "sch_1", kind: "cron", cron: "*/5 * * * *" } })])).toEqual({
      scheduleKind: "cron",
      scheduleDetail: "*/5 * * * *",
    })
  })

  test("reads the first line of a wakeup's reason", () => {
    expect(
      scheduleContinuation([
        part({ schedule: { id: "sch_2", kind: "wakeup", reason: " waiting for CI\nthen deploy" } }),
      ]),
    ).toEqual({ scheduleKind: "wakeup", scheduleDetail: "waiting for CI" })
  })

  test("is empty for other background prompts and unusable metadata", () => {
    expect(scheduleContinuation([part()])).toEqual({})
    expect(scheduleContinuation([part({ hook: "Stop", reason: "x" })])).toEqual({})
    expect(scheduleContinuation([part({ schedule: { id: "sch_3", kind: "cron" } })])).toEqual({})
    expect(scheduleContinuation([part({ schedule: { id: "sch_4", kind: "other", cron: "* * * * *" } })])).toEqual({})
  })

  test("the divider copy matches the spec", () => {
    expect(dict["session.timeline.scheduledDivider"]).toBe("⏰ Scheduled · {{cron}}")
    expect(dict["session.timeline.wakeupDivider"]).toBe("⏰ Wakeup · {{reason}}")
  })
})
