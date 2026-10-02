import { describe, expect, test } from "bun:test"
import { runSessionBulk } from "./session-bulk-run"

describe("runSessionBulk", () => {
  test("archives in order and does not check a v1 gate", async () => {
    const calls: string[] = []
    const result = await runSessionBulk({
      ids: ["a", "b"],
      op: "archive",
      isProtected: () => false,
      archive: async (id) => {
        calls.push(`archive:${id}`)
      },
      remove: async (id) => {
        calls.push(`remove:${id}`)
      },
    })
    expect(calls).toEqual(["archive:a", "archive:b"])
    expect(result).toEqual({ done: ["a", "b"], pending: [], skipped: [] })
  })

  test("deletes once per root and stops after the first failure", async () => {
    const calls: string[] = []
    const result = await runSessionBulk({
      ids: ["a", "b", "c"],
      op: "delete",
      isProtected: (id) => id === "a",
      archive: async () => {
        throw new Error("archive")
      },
      remove: async (id) => {
        calls.push(id)
        if (id === "b") throw new Error("nope")
      },
    })
    expect(calls).toEqual(["b"])
    expect(result).toEqual({ done: [], failed: "b", pending: ["c"], skipped: ["a"] })
  })
})
