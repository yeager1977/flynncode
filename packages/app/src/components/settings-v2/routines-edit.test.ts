import { describe, expect, test } from "bun:test"
import { addRoutine, removeRoutine, routinesFromConfig, routinesToConfig, toggleRoutine } from "./routines-edit"

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

  test("adds, toggles, and removes", () => {
    const added = addRoutine([], { name: "Triage", prompt: "Check CI", dailyAt: "09:00" })
    expect(added[0]?.id).toBe("triage")
    expect(toggleRoutine(added, "triage")[0]?.enabled).toBe(false)
    expect(removeRoutine(added, "triage")).toEqual([])
  })
})
