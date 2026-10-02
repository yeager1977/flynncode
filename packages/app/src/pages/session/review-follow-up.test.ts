import { describe, expect, test } from "bun:test"
import { reviewFollowUp } from "./review-follow-up"

describe("reviewFollowUp", () => {
  test("includes the selected scope and comment locations without reverting a message", () => {
    const text = reviewFollowUp({
      scope: "turn",
      comments: [{ file: "src/a.ts", startLine: 4, endLine: 6, comment: "rename this" }],
    })
    expect(text).toContain("last turn")
    expect(text).toContain("src/a.ts:4-6: rename this")
    expect(text).not.toContain("revert")
  })
})
