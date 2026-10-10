import { describe, expect, test } from "bun:test"
import { presetArgs, buildDetachedReviewText, sessionPrefillKey } from "./review-detached"

describe("review detached delivery", () => {
  test("builds the slash prompt text for a preset", () => {
    expect(buildDetachedReviewText("dev")).toBe("/review dev")
    expect(buildDetachedReviewText("")).toBe("/review")
  })

  test("scopes the prefill key to the forked session", () => {
    expect(sessionPrefillKey("ses_123")).toBe("flynncode.review-prefill:ses_123")
  })

  test("presetArgs mirrors the server twin", () => {
    expect(presetArgs("uncommitted")).toBe("")
    expect(presetArgs("base-branch", "main")).toBe("main")
    expect(presetArgs("commit", "abc1234")).toBe("abc1234")
    expect(presetArgs("base-branch", "  ")).toBe("")
  })
})
