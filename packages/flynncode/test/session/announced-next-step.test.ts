import { describe, expect, test } from "bun:test"
import { announcedNextStep } from "@/session/prompt"

type Message = Parameters<typeof announcedNextStep>[0]

// Only the fields announcedNextStep reads; the rest of a stored message is irrelevant here.
const final = (text: string, extra: { finish?: string; tool?: boolean; role?: string } = {}) =>
  ({
    info: { role: extra.role ?? "assistant", finish: extra.finish ?? "stop" },
    parts: [{ type: "text", text }, ...(extra.tool ? [{ type: "tool" }] : [])],
  }) as unknown as Message

describe("announcedNextStep", () => {
  test("flags a turn that ends on a colon or ellipsis", () => {
    expect(announcedNextStep(final("The core works, so the helper is wrong. Fixing:"))).toBe(true)
    expect(announcedNextStep(final("Now the session retention spec:\n"))).toBe(true)
    expect(announcedNextStep(final("Checking the logs…"))).toBe(true)
    expect(announcedNextStep(final("Rolling out the new images:**"))).toBe(true)
  })

  test("flags a short last paragraph that opens with an intent", () => {
    expect(announcedNextStep(final("Now I'll write the plan."))).toBe(true)
    expect(announcedNextStep(final("Tasks 1-3 are done.\n\nMoving on to the worktree routes (Task 4 of 7)."))).toBe(true)
    expect(announcedNextStep(final("Good. Let me run the suite."))).toBe(true)
  })

  test("leaves finished answers, questions and sign-offs alone", () => {
    expect(announcedNextStep(final("All done: the deb is in Downloads."))).toBe(false)
    expect(announcedNextStep(final("Want me to roll it out to QA as well?"))).toBe(false)
    expect(announcedNextStep(final("Fixed.\n\nLet me know if anything else breaks."))).toBe(false)
    expect(announcedNextStep(final(""))).toBe(false)
    expect(
      announcedNextStep(
        final(
          "Let me explain what happened: the sidecar runs on Node, so every Bun-only call failed when a long command was promoted to a background shell, and the reaper hit the same error at startup.",
        ),
      ),
    ).toBe(false)
  })

  test("only counts tool-free assistant messages that finished with stop", () => {
    expect(announcedNextStep(final("Fixing:", { tool: true }))).toBe(false)
    expect(announcedNextStep(final("Fixing:", { finish: "length" }))).toBe(false)
    expect(announcedNextStep(final("Fixing:", { role: "user" }))).toBe(false)
  })
})
