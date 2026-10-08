import { describe, expect, test } from "bun:test"
import { buildDetachedReviewText, sessionPrefillKey } from "./review-detached"

describe("review detached delivery", () => {
  test("builds the slash prompt text for a preset", () => {
    expect(buildDetachedReviewText("dev")).toBe("/review dev")
    expect(buildDetachedReviewText("")).toBe("/review")
  })

  test("scopes the prefill key to the forked session", () => {
    expect(sessionPrefillKey("ses_123")).toBe("flynncode.review-prefill:ses_123")
  })
})
