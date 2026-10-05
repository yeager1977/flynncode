import { describe, expect, test } from "bun:test"
import path from "path"
import { parseRunRecords, recordRoutineRun, type RoutineRun } from "../../../src/plugin/routines/index"
import { tmpdir } from "../../fixture/fixture"

const record = (n: number): RoutineRun => ({
  routineId: `routine-${n}`,
  sessionID: `session-${n}`,
  agent: "build",
  startedAt: new Date(2026, 8, 22, 9, n).toISOString(),
  endedAt: new Date(2026, 8, 22, 9, n, 30).toISOString(),
  state: "ok",
})

describe("recordRoutineRun", () => {
  test("appends and parses JSONL records", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "routines-runs.jsonl")
    await recordRoutineRun(record(1), file)
    await recordRoutineRun(record(2), file)
    const records = parseRunRecords(await Bun.file(file).text())
    expect(records.map((row) => row.routineId)).toEqual(["routine-1", "routine-2"])
  })

  test("caps the file at the last 200 records", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "routines-runs.jsonl")
    await Bun.write(file, Array.from({ length: 205 }, (_, i) => JSON.stringify(record(i))).join("\n") + "\n")
    await recordRoutineRun(record(205), file)
    const records = parseRunRecords(await Bun.file(file).text())
    expect(records).toHaveLength(200)
    expect(records[0]?.routineId).toBe("routine-6")
    expect(records[199]?.routineId).toBe("routine-205")
  })

  test("skips corrupt lines when rewriting", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "routines-runs.jsonl")
    await Bun.write(file, `not json\n${JSON.stringify(record(1))}\n`)
    await recordRoutineRun(record(2), file)
    const records = parseRunRecords(await Bun.file(file).text())
    expect(records.map((row) => row.routineId)).toEqual(["routine-1", "routine-2"])
  })

  test("records error state with message", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "routines-runs.jsonl")
    await recordRoutineRun({ ...record(1), state: "error", error: "boom", sessionID: undefined }, file)
    const records = parseRunRecords(await Bun.file(file).text())
    expect(records[0]).toMatchObject({ state: "error", error: "boom" })
  })
})
