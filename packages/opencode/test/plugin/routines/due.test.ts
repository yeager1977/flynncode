import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { dueRoutines, isDue, nextOccurrence } from "../../../src/plugin/routines/due"
import type { Routine } from "../../../src/plugin/routines/parse"

const routine = (patch: Partial<Routine> = {}): Routine => ({
  id: "triage",
  name: "Triage",
  prompt: "Check CI",
  enabled: true,
  dailyAt: "09:00",
  ...patch,
})

describe("isDue", () => {
  test("is due at the configured minute when never run", () => {
    expect(isDue(routine(), new Date(2026, 8, 22, 9, 0, 12))).toBe(true)
  })

  test("is due later the same day if never run", () => {
    expect(isDue(routine(), new Date(2026, 8, 22, 15, 30))).toBe(true)
  })

  test("is not due before dailyAt", () => {
    expect(isDue(routine(), new Date(2026, 8, 22, 8, 59))).toBe(false)
  })

  test("skips disabled routines", () => {
    expect(isDue(routine({ enabled: false }), new Date(2026, 8, 22, 9, 0))).toBe(false)
  })

  test("does not run twice the same local day", () => {
    const ran = routine({ lastRun: new Date(2026, 8, 22, 9, 0, 5).toISOString() })
    expect(isDue(ran, new Date(2026, 8, 22, 9, 0, 40))).toBe(false)
  })

  test("runs again the next day", () => {
    const ran = routine({ lastRun: new Date(2026, 8, 21, 9, 0).toISOString() })
    expect(dueRoutines([ran], new Date(2026, 8, 22, 9, 0))).toEqual([ran])
  })

  test("fires once when yesterday's scheduled run was missed", () => {
    const missed = routine({ lastRun: new Date(2026, 8, 20, 9, 0).toISOString() })
    expect(isDue(missed, new Date(2026, 8, 22, 8, 0))).toBe(true)
  })

  test("does not refire after recovering a missed day", () => {
    const recovered = routine({ lastRun: new Date(2026, 8, 22, 8, 0).toISOString() })
    expect(isDue(recovered, new Date(2026, 8, 22, 8, 30))).toBe(false)
  })

  test("waits for today's time when yesterday ran", () => {
    const ranYesterday = routine({ lastRun: new Date(2026, 8, 21, 9, 0).toISOString() })
    expect(isDue(ranYesterday, new Date(2026, 8, 22, 8, 0))).toBe(false)
  })
})

describe("manual", () => {
  test("is never due", () => {
    expect(isDue(routine({ dailyAt: undefined }), new Date(2026, 8, 22, 15, 30))).toBe(false)
  })
})

describe("interval", () => {
  test("is due when never run", () => {
    expect(isDue(routine({ dailyAt: undefined, interval: "15m" }), new Date(2026, 8, 22, 9, 0))).toBe(true)
  })

  test("is due at lastRun + interval", () => {
    const ran = routine({ dailyAt: undefined, interval: "1h", lastRun: new Date(2026, 8, 22, 9, 0).toISOString() })
    expect(isDue(ran, new Date(2026, 8, 22, 10, 0))).toBe(true)
    expect(isDue(ran, new Date(2026, 8, 22, 9, 59))).toBe(false)
  })

  test("supports 15m/6h/1d/1w cadence", () => {
    const at = new Date(2026, 8, 22, 12, 0)
    const since = (interval: "15m" | "6h" | "1d" | "1w", ms: number) =>
      routine({ dailyAt: undefined, interval, lastRun: new Date(at.getTime() - ms).toISOString() })
    expect(isDue(since("15m", 15 * 60_000), at)).toBe(true)
    expect(isDue(since("6h", 6 * 60 * 60_000), at)).toBe(true)
    expect(isDue(since("1d", 24 * 60 * 60_000), at)).toBe(true)
    expect(isDue(since("1w", 7 * 24 * 60 * 60_000), at)).toBe(true)
    expect(isDue(since("1w", 6 * 24 * 60 * 60_000), at)).toBe(false)
  })

  test("invalid lastRun fires once", () => {
    expect(isDue(routine({ dailyAt: undefined, interval: "1h", lastRun: "not-a-date" }), new Date(2026, 8, 22, 9, 0))).toBe(true)
  })
})

describe("rrule", () => {
  test("fires on a matching weekday", () => {
    const weekly = routine({ dailyAt: undefined, rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" })
    // 2026-09-21 is a Monday
    expect(isDue(weekly, new Date(2026, 8, 21, 9, 0))).toBe(true)
    expect(isDue(weekly, new Date(2026, 8, 22, 9, 0))).toBe(false)
  })

  test("does not refire after running", () => {
    const ran = routine({
      dailyAt: undefined,
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
      lastRun: new Date(2026, 8, 21, 9, 0, 5).toISOString(),
    })
    expect(isDue(ran, new Date(2026, 8, 21, 9, 0, 40))).toBe(false)
  })

  test("invalid rrule never fires", () => {
    const broken = routine({ dailyAt: undefined, rrule: "EVERY=monday" })
    expect(isDue(broken, new Date(2026, 8, 21, 9, 0))).toBe(false)
  })
})

describe("rrule in a non-UTC timezone", () => {
  const previous = process.env.TZ
  beforeAll(() => {
    process.env.TZ = "America/New_York"
  })
  afterAll(() => {
    process.env.TZ = previous
  })

  test("BYHOUR is local wall-clock time", () => {
    const daily = routine({ dailyAt: undefined, rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" })
    // 09:00 UTC is 05:00 in New York; the rule must wait for 09:00 local.
    expect(isDue(daily, new Date(2026, 8, 22, 5, 30))).toBe(false)
    expect(isDue(daily, new Date(2026, 8, 22, 9, 0))).toBe(true)
    expect(nextOccurrence(daily, new Date(2026, 8, 22, 5, 30))?.getHours()).toBe(9)
  })

  test("COUNT rules anchor at createdAt and stop after COUNT runs", () => {
    const twice = routine({
      dailyAt: undefined,
      rrule: "FREQ=DAILY;COUNT=2;BYHOUR=9;BYMINUTE=0",
      createdAt: new Date(2026, 8, 20, 8, 0).toISOString(),
    })
    expect(isDue(twice, new Date(2026, 8, 20, 9, 0))).toBe(true)
    const done = { ...twice, lastRun: new Date(2026, 8, 21, 9, 0, 5).toISOString() }
    expect(isDue(done, new Date(2026, 8, 25, 9, 0))).toBe(false)
  })

  test("honors a supplied DTSTART", () => {
    const later = routine({
      dailyAt: undefined,
      rrule: "DTSTART:20261001T090000\nRRULE:FREQ=DAILY",
      createdAt: new Date(2026, 8, 20, 8, 0).toISOString(),
    })
    expect(isDue(later, new Date(2026, 8, 25, 12, 0))).toBe(false)
    expect(isDue(later, new Date(2026, 9, 1, 9, 0))).toBe(true)
  })

  test("FREQ=DAILY without BYHOUR fires at the createdAt time of day", () => {
    const daily = routine({
      dailyAt: undefined,
      rrule: "FREQ=DAILY",
      createdAt: new Date(2026, 8, 20, 14, 30).toISOString(),
      lastRun: new Date(2026, 8, 21, 14, 30, 5).toISOString(),
    })
    expect(isDue(daily, new Date(2026, 8, 22, 14, 0))).toBe(false)
    expect(isDue(daily, new Date(2026, 8, 22, 14, 30))).toBe(true)
  })
})
