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
})
