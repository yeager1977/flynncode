import { describe, expect, test } from "bun:test"
import { addDispatch, completeDispatch, failDispatch, migrateDispatch, reconcileDispatch } from "./dispatch-store"

const task = {
  sessionID: "ses_1",
  title: "Fix tests",
  status: "running" as const,
  directory: "/proj",
}

describe("dispatch store", () => {
  test("adds a running task at the front", () => {
    expect(addDispatch([], task)).toEqual([task])
  })

  test("marks a task done", () => {
    expect(completeDispatch([task], "ses_1")[0]?.status).toBe("done")
  })

  test("marks a failed send without treating it as still running", () => {
    expect(failDispatch([task], "ses_1")[0]?.status).toBe("failed")
  })

  test("keeps a restarted task running only while its session is active", () => {
    const idle = reconcileDispatch([task], new Set())
    const input = [task]
    const live = reconcileDispatch(input, new Set(["ses_1"]))
    expect(idle[0]?.status).toBe("done")
    expect(live).toBe(input)
  })

  test("restores a saved list and drops a corrupt row", () => {
    const restored = migrateDispatch({
      tasks: [task, { sessionID: "bad" }],
    })
    expect(restored.tasks).toEqual([task])
  })
})
