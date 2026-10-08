import { describe, expect, test } from "bun:test"
import { activityStatus, inboxRowStatus, inboxStatus } from "./activity-status"

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

describe("inboxRowStatus", () => {
  test("returns the stored status when no live status exists", () => {
    expect(inboxRowStatus("dispatch", "done")).toBe("done")
  })

  test("keeps the stored terminal status when live is idle without waiting", () => {
    expect(inboxRowStatus("dispatch", "done", { type: "idle" }, false)).toBe("done")
  })

  test("maps live idle with waiting onto needs-input", () => {
    expect(inboxRowStatus("dispatch", "running", { type: "idle" }, true)).toBe("needs-input")
  })

  test("maps live busy onto running", () => {
    expect(inboxRowStatus("session", "running", { type: "busy" }, false)).toBe("running")
  })

  test("accepts the routine kind without changing the mapping", () => {
    expect(inboxRowStatus("routine", "failed")).toBe("failed")
  })
})
