import { describe, expect, test } from "bun:test"
import { addDispatch, completeDispatch } from "./dispatch-store"

describe("dispatch store", () => {
  test("adds a running task at the front", () => {
    const next = addDispatch([], { sessionID: "ses_1", title: "Fix tests", status: "running" })
    expect(next).toEqual([{ sessionID: "ses_1", title: "Fix tests", status: "running" }])
  })

  test("marks a task done", () => {
    const next = completeDispatch([{ sessionID: "ses_1", title: "Fix tests", status: "running" }], "ses_1")
    expect(next[0]?.status).toBe("done")
  })
})
