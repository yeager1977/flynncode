import { describe, expect, test } from "bun:test"
import { MemoryExtract } from "../../src/memory/extract"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

function user(text: string) {
  return { info: { role: "user" }, parts: [{ type: "text", text }] } as unknown as SessionV1.WithParts
}

describe("shouldExtract", () => {
  test("skips short sessions", () => {
    expect(MemoryExtract.shouldExtract({ messages: [user("hi")], min_turns: 4 })).toBe(false)
  })
  test("skips sessions that are only compaction markers", () => {
    const compaction = { info: { role: "user" }, parts: [{ type: "compaction" }] } as unknown as SessionV1.WithParts
    expect(
      MemoryExtract.shouldExtract({ messages: [compaction, compaction, compaction, compaction], min_turns: 4 }),
    ).toBe(false)
  })
  test("extracts at threshold", () => {
    expect(
      MemoryExtract.shouldExtract({ messages: [user("a"), user("b"), user("c"), user("d")], min_turns: 4 }),
    ).toBe(true)
  })
})

describe("buildExtractionPrompt", () => {
  test("forbids secrets and scopes to durable conventions", () => {
    const prompt = MemoryExtract.buildExtractionPrompt({ conversation: "prefers bun" })
    expect(prompt).toMatch(/never.*secret|no.*secret|forbid.*secret/i)
    expect(prompt).toContain("prefers bun")
  })
})
