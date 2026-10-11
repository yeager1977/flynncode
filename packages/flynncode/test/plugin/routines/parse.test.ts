import { describe, expect, test } from "bun:test"
import { parseRoutines } from "../../../src/plugin/routines/parse"

describe("parseRoutines", () => {
  test("empty input is an empty list", () => {
    expect(parseRoutines(undefined)).toEqual({ ok: true, value: { routines: [] } })
  })

  test("parses a daily routine and defaults enabled", () => {
    const result = parseRoutines({
      routines: [{ id: "triage", name: "Triage", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0]).toEqual({
      id: "triage",
      name: "Triage",
      prompt: "Check CI",
      enabled: true,
      dailyAt: "09:00",
      lastRun: undefined,
    })
  })

  test("rejects a bad clock", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { dailyAt: "25:00" } }],
    })
    expect(result.ok).toBe(false)
  })

  test("parses a manual schedule string", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: "manual" }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0]).toMatchObject({ id: "a", dailyAt: undefined, interval: undefined })
  })

  test("parses a dailyAt schedule", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { dailyAt: "08:30" } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0]).toMatchObject({ id: "a", dailyAt: "08:30", interval: undefined })
  })

  test("parses an interval schedule", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { interval: "6h" } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0]).toMatchObject({ id: "a", dailyAt: undefined, interval: "6h" })
  })

  test("rejects an unknown interval", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { interval: "3h" } }],
    })
    expect(result.ok).toBe(false)
  })

  test("rejects an unknown schedule string", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: "hourly" }],
    })
    expect(result.ok).toBe(false)
  })

  test("rejects schedule with both dailyAt and interval", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { dailyAt: "09:00", interval: "1h" } }],
    })
    expect(result.ok).toBe(false)
  })

  test("accepts every documented interval", () => {
    for (const interval of ["15m", "1h", "6h", "1d", "1w"]) {
      const result = parseRoutines({
        routines: [{ id: "a", name: "A", prompt: "go", schedule: { interval } }],
      })
      expect(result.ok).toBe(true)
    }
  })

  test("parses a raw routine array from config", () => {
    const result = parseRoutines([
      { id: "triage", name: "Triage", prompt: "Check CI", schedule: { dailyAt: "09:00" } },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0]).toEqual({
      id: "triage",
      name: "Triage",
      prompt: "Check CI",
      enabled: true,
      dailyAt: "09:00",
      lastRun: undefined,
    })
  })
})

describe("rrule schedule", () => {
  test("parses an RRULE schedule", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0]).toMatchObject({ id: "a", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" })
  })

  test("parses a bare FREQ-only RRULE", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { rrule: "FREQ=DAILY" } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0]).toMatchObject({ id: "a", rrule: "FREQ=DAILY" })
  })

  test("rejects an invalid RRULE string", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { rrule: "EVERY=monday" } }],
    })
    expect(result.ok).toBe(false)
  })

  test("rejects rrule combined with dailyAt", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { dailyAt: "09:00", rrule: "FREQ=DAILY" } }],
    })
    expect(result.ok).toBe(false)
  })
})

describe("recentRuns", () => {
  test("keeps valid summaries and drops bad entries", () => {
    const result = parseRoutines({
      routines: [
        {
          id: "a",
          name: "A",
          prompt: "go",
          schedule: { dailyAt: "09:00" },
          recentRuns: [
            { startedAt: "2026-09-22T09:00:00.000Z", endedAt: "2026-09-22T09:01:00.000Z", state: "ok" },
            "nope",
            { startedAt: "2026-09-22T09:00:00.000Z", endedAt: "2026-09-22T09:01:00.000Z", state: "bogus" },
          ],
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0].recentRuns?.length).toBe(1)
  })

  test("omits recentRuns when empty", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { dailyAt: "09:00" } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0].recentRuns).toBeUndefined()
  })
})

describe("target", () => {
  test("accepts an object with url and optional credentials", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { interval: "1h" }, target: { url: "http://deepthought:4096", username: "u", password: "p" } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0].target).toEqual({ url: "http://deepthought:4096", username: "u", password: "p" })
  })

  test("accepts the literal \"local\"", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { interval: "1h" }, target: "local" }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0].target).toBe("local")
  })

  test("accepts a bare url with no credentials", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { interval: "1h" }, target: { url: "https://deepthought.lan" } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0].target).toEqual({ url: "https://deepthought.lan" })
  })

  test("treats explicitly empty credentials as omitted", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { interval: "1h" }, target: { url: "http://deepthought:4096", username: "", password: "" } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0].target).toEqual({ url: "http://deepthought:4096" })
  })

  test("rejects a non-http url", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { interval: "1h" }, target: { url: "ftp://deepthought" } }],
    })
    expect(result.ok).toBe(false)
  })

  test("rejects a missing or malformed url", () => {
    for (const target of [{}, { url: 42 }, "self"]) {
      const result = parseRoutines({
        routines: [{ id: "a", name: "A", prompt: "go", schedule: { interval: "1h" }, target }],
      })
      expect(result.ok).toBe(false)
    }
  })

  test("rejects non-string credentials", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { interval: "1h" }, target: { url: "http://deepthought:4096", password: 12345 } }],
    })
    expect(result.ok).toBe(false)
  })
})
