import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"

describe("multifold session validation", () => {
  test("create input decodes additionalDirectories", async () => {
    const { Session } = await import("@/session/session")
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(Session.CreateInput)({ additionalDirectories: ["/docs"] }),
    )
    expect(decoded?.additionalDirectories).toEqual(["/docs"])
  })
  test("create input omits additionalDirectories when absent", async () => {
    const { Session } = await import("@/session/session")
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(Session.CreateInput)({ title: "plain" }))
    expect(decoded?.additionalDirectories).toBeUndefined()
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
