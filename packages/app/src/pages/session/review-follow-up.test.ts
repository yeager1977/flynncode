import { describe, expect, test } from "bun:test"
import { reviewFollowUp } from "./review-follow-up"

describe("reviewFollowUp", () => {
  test("uses the caller-supplied header and lists comment locations", () => {
    const text = reviewFollowUp({
      header: "Address these review comments on the last turn.",
      comments: [{ file: "src/a.ts", startLine: 4, endLine: 6, comment: "rename this" }],
    })
    expect(text).toContain("Address these review comments on the last turn.")
    expect(text).toContain("src/a.ts:4-6: rename this")
    expect(text).not.toContain("revert")
  })
})

test("empty comment list yields the header alone", () => {
  const text = reviewFollowUp({ header: "Address these review comments on the last turn.", comments: [] })
  expect(text).toBe("Address these review comments on the last turn.")
})
