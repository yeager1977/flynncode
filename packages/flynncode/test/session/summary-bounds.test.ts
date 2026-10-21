import { describe, expect, test } from "bun:test"
import { boundSummaryDiffs, summaryLimit } from "../../src/session/summary"
import type { Snapshot } from "@/snapshot"

const diff = (file: string, patch: string): Snapshot.FileDiff => ({
  file,
  patch,
  additions: 1,
  deletions: 0,
  status: "modified",
})

describe("boundSummaryDiffs", () => {
  test("keeps the file metadata and the patches that fit the budget", () => {
    const result = boundSummaryDiffs([diff("a.ts", "x".repeat(1024)), diff("b.ts", "y".repeat(1024))])

    expect(result.map((item) => item.file)).toEqual(["a.ts", "b.ts"])
    expect(result[0]?.patch).toHaveLength(1024)
    expect(result[1]?.patch).toHaveLength(1024)
  })

  test("drops patch text once the budget is spent but keeps the counts", () => {
    const first = "x".repeat(summaryLimit.patchBytes)
    const result = boundSummaryDiffs([diff("a.ts", first), diff("b.ts", "tail")])

    expect(result[0]?.patch).toHaveLength(summaryLimit.patchBytes)
    expect(result[1]?.patch).toBe("")
    expect(result[1]?.additions).toBe(1)
    expect(result[1]?.file).toBe("b.ts")
  })

  test("caps the number of stored files", () => {
    const many = Array.from({ length: summaryLimit.files + 10 }, (_, index) => diff(`f${index}.ts`, ""))

    const result = boundSummaryDiffs(many)

    expect(result).toHaveLength(summaryLimit.files)
    expect(result.at(-1)?.file).toBe(`f${summaryLimit.files - 1}.ts`)
  })
})
