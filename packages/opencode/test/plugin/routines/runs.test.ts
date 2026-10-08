import { describe, expect, test } from "bun:test"
import { parseRunRecords, type RoutineRun } from "../../../src/plugin/routines/index"

function run(patch: Partial<RoutineRun> = {}): RoutineRun {
  return {
    routineId: "triage",
    agent: "build",
    startedAt: new Date(2026, 8, 22, 9, 0).toISOString(),
    endedAt: new Date(2026, 8, 22, 9, 1).toISOString(),
    state: "ok",
    ...patch,
  }
}

describe("parseRunRecords", () => {
  test("skips corrupt lines and keeps the tail", () => {
    const text = [JSON.stringify(run()), "not-json", "", JSON.stringify(run({ state: "error" }))].join("\n")
    const records = parseRunRecords(text)
    expect(records.length).toBe(2)
    expect(records[1].state).toBe("error")
  })

  test("caps at the newest 200", () => {
    const text = Array.from({ length: 250 }, (_, n) =>
      JSON.stringify(run({ startedAt: new Date(2026, 8, 22, 9, 0, n).toISOString() })),
    ).join("\n")
    expect(parseRunRecords(text).length).toBe(200)
  })
})
