import { describe, expect, test } from "bun:test"
import { activityStatus, inboxStatus } from "./activity-status"

describe("activityStatus", () => {
  test("maps session status onto the activity inbox", () => {
    expect(activityStatus({ type: "busy" })).toBe("running")
    expect(activityStatus({ type: "idle" })).toBe("needs-input")
    expect(activityStatus({ blocked: true, type: "busy" })).toBe("blocked")
  })

  test("keeps the stored status when no live session status exists", () => {
    expect(inboxStatus("done")).toBe("done")
  })

  test("keeps the stored status when the live session is idle and unblocked", () => {
    expect(inboxStatus("done", { type: "idle" })).toBe("done")
    expect(inboxStatus("running", { type: "idle" })).toBe("running")
  })

  test("follows the live status while the session is working or blocked", () => {
    expect(inboxStatus("running", { type: "busy" })).toBe("running")
    expect(inboxStatus("running", { type: "idle", blocked: true })).toBe("needs-input")
  })
})
