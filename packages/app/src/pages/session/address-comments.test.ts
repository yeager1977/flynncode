import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"

const source = readFileSync(new URL("../session.tsx", import.meta.url), "utf8")

// Scoped extraction: the contract must hold for the addressComments handler
// body specifically, not the standalone followup dock machinery elsewhere in
// session.tsx (followupMutation, queueFollowup, the dock's sendFollowup).
const handlerBody = (from: string) => {
  const start = from.indexOf("const addressComments = (")
  if (start === -1) throw new Error("addressComments handler not found in session.tsx")
  let depth = 0
  for (let index = from.indexOf("{", start); index < from.length; index++) {
    const char = from[index]
    if (char === "{") depth++
    if (char === "}") {
      depth--
      if (depth === 0) return from.slice(start, index + 1)
    }
  }
  throw new Error("unterminated addressComments handler")
}

const handler = handlerBody(source)

describe("address comments wiring", () => {
  test("handler sends a followup draft when the session is idle", () => {
    expect(handler).toContain("sendFollowupDraft")
  })

  test("handler queues the same draft on the busy branch and returns before the send branch", () => {
    const busyAt = handler.indexOf("busy(sessionID)")
    const queueAt = handler.indexOf("queueFollowup(draft)")
    const sendAt = handler.indexOf("sendFollowupDraft")
    expect(busyAt).toBeGreaterThan(-1)
    expect(queueAt).toBeGreaterThan(busyAt)
    expect(sendAt).toBeGreaterThan(queueAt)
    // The busy branch exits before the send call, so the send path stays
    // reachable only for idle sessions.
    expect(handler.slice(busyAt, sendAt)).toContain("return")
  })

  test("draft context items carry the review selection", () => {
    // Scoped to the handler so the assertion pins the synthesized items, not
    // addCommentToContext's own commentOrigin usage further up the file.
    expect(handler).toContain('commentOrigin: "review"')
  })
})
