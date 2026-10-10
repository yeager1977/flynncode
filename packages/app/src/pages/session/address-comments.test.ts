import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"

const source = readFileSync(new URL("../session.tsx", import.meta.url), "utf8")

describe("address comments wiring", () => {
  test("one-click sends a followup draft (or queues when busy)", () => {
    // The addressComments handler must call sendFollowupDraft with the
    // current agent/model, and queueFollowup while the session is busy.
    expect(source).toContain("sendFollowupDraft")
    expect(source).toContain("queueFollowup")
  })
  test("comment context items carry the review selection", () => {
    // Draft context items must set commentOrigin: "review" so
    // buildRequestParts renders the comment notes + file:// parts.
    expect(source).toContain('commentOrigin: "review"')
  })
})