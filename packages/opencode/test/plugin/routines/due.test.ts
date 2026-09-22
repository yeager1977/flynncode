import { describe, expect, test } from "bun:test"
import { dueRoutines, isDue } from "../../../src/plugin/routines/due"
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
})
