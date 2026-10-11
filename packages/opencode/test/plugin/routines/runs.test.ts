import { describe, expect, test } from "bun:test"
import path from "path"
import { parseRunRecords, readRoutineRuns, recordRoutineRun, type RoutineRun } from "../../../src/plugin/routines/index"
import { tmpdir } from "../../fixture/fixture"

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

const record = (n: number): RoutineRun => ({
  routineId: `routine-${n}`,
  sessionID: `session-${n}`,
  agent: "build",
  startedAt: new Date(2026, 8, 22, 9, n).toISOString(),
  endedAt: new Date(2026, 8, 22, 9, n, 30).toISOString(),
  state: "ok",
})

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

describe("readRoutineRuns", () => {
  test("reads the jsonl tail in run order", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "routines-runs.jsonl")
    await Bun.write(file, [record(1), record(2), record(3)].map((row) => JSON.stringify(row)).join("\n") + "\n")
    const records = await readRoutineRuns(file)
    expect(records.map((row) => row.routineId)).toEqual(["routine-1", "routine-2", "routine-3"])
  })

  test("returns [] for a missing or empty file instead of failing", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "routines-runs.jsonl")
    expect(await readRoutineRuns(file)).toEqual([])
    await Bun.write(file, "")
    expect(await readRoutineRuns(file)).toEqual([])
  })

  test("skips corrupt lines and caps at the newest 200", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "routines-runs.jsonl")
    await Bun.write(file, `not-json\n${JSON.stringify(record(1))}\n`)
    const records = await readRoutineRuns(file)
    expect(records.map((row) => row.routineId)).toEqual(["routine-1"])
  })
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
