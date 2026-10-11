import { describe, expect, test } from "bun:test"
import { addRoutine, isValidRrule, removeRoutine, routinesFromConfig, routinesToConfig, toggleRoutine, updateRoutine } from "./routines-edit"

describe("routines editor", () => {
  test("reads and writes the stored shape", () => {
    const routines = routinesFromConfig({
      routines: [{ id: "triage", name: "Triage", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
    })
    expect(routines[0]?.dailyAt).toBe("09:00")
    expect(routinesToConfig(routines).routines[0]).toMatchObject({
      id: "triage",
      schedule: { dailyAt: "09:00" },
      enabled: true,
    })
  })

  test("round-trips scheduler-owned fields Settings does not edit", () => {
    const stored = {
      id: "watch",
      name: "Watch",
      prompt: "Review changes",
      createdAt: "2026-10-01T00:00:00.000Z",
      directory: "/repo",
      trigger: { files: ["src/**/*.ts"] },
    }
    expect(routinesToConfig(routinesFromConfig({ routines: [stored] })).routines[0]).toMatchObject(stored)
  })

  test("adds, toggles, and removes", () => {
    const added = addRoutine([], { name: "Triage", prompt: "Check CI", dailyAt: "09:00" })
    expect(added[0]?.id).toBe("triage")
    expect(toggleRoutine(added, "triage")[0]?.enabled).toBe(false)
    expect(removeRoutine(added, "triage")).toEqual([])
  })

  test("updateRoutine replaces one routine's schedule fields", () => {
    const before = routinesFromConfig({
      routines: [{ id: "r1", name: "mornings", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
    })
    const after = updateRoutine(before, "r1", { rrule: "FREQ=WEEKLY;BYDAY=MO" })
    const target = after[0]
    expect(target?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO")
    expect(target?.dailyAt).toBeUndefined() // one-of constraint
    expect(target?.name).toBe("mornings")
  })

  test("updateRoutine rejects an invalid rrule", () => {
    const before = routinesFromConfig({
      routines: [{ id: "r1", name: "mornings", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
    })
    expect(() => updateRoutine(before, "r1", { rrule: "FREQ=" })).toThrow()
  })

  test("updateRoutine clears the schedule when every schedule patch field is absent-valued", () => {
    const before = routinesFromConfig({
      routines: [{ id: "r1", name: "mornings", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
    })
    const after = updateRoutine(before, "r1", { dailyAt: undefined, interval: undefined, rrule: undefined })
    const target = after[0]
    expect(target?.dailyAt).toBeUndefined()
    expect(target?.interval).toBeUndefined()
    expect(target?.rrule).toBeUndefined()
  })

  test("accepts bare and extended RRULE input like the backend", () => {
    expect(isValidRrule("FREQ=DAILY")).toBe(true)
    expect(isValidRrule("FREQ=WEEKLY;BYDAY=MO")).toBe(true)
    expect(isValidRrule("EVERY=monday")).toBe(false)
    expect(isValidRrule("FREQ=daily")).toBe(false)
    expect(isValidRrule("FREQ=DAILY extra")).toBe(false)
  })
})
