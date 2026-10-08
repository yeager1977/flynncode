import { describe, expect, test } from "bun:test"

describe("multifold session validation", () => {
  test("create input carries additionalDirectories", async () => {
    const { Session } = await import("@/session/session")
    expect(JSON.stringify(Session.CreateInput.ast)).toContain("additionalDirectories")
  })
  test("extras cap is 8", async () => {
    const { MaxExtras } = await import("@opencode-ai/core/project/folders")
    expect(MaxExtras).toBe(8)
  })
  test("multifold errors are typed", async () => {
    const { Session } = await import("@/session/session")
    const error = new Session.MultifoldError({ reason: "limit" })
    expect(error.reason).toBe("limit")
  })
})
