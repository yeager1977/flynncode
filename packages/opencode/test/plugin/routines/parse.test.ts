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
