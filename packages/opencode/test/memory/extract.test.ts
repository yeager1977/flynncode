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

  test("extraction prompt demands topic slugs", () => {
    const prompt = MemoryExtract.buildExtractionPrompt({ conversation: "prefers bun" })
    expect(prompt).toContain("SLUG:")
    expect(prompt).toContain("NOTHING TO REMEMBER")
  })
})

describe("parseExtractionTopics", () => {
  test("parses SLUG blocks into topics", () => {
    const topics = MemoryExtract.parseExtractionTopics(
      "SLUG: test-runner\n- always use bun\n\nSLUG: commit style\n- conventional commits\n- keep it short",
    )
    expect(topics.length).toBe(2)
    expect(topics[0].slug).toBe("test-runner")
    expect(topics[0].text).toBe("- always use bun")
    expect(topics[1].slug).toBe("commit-style")
    expect(topics[1].text).toContain("conventional commits")
  })

  test("dedupes repeated slugs and skips blocks without bullets", () => {
    const topics = MemoryExtract.parseExtractionTopics(
      "SLUG: test-runner\n- bun only\nSLUG: test-runner\n- avoid vitest\nSLUG: empty-topic\n",
    )
    expect(topics.length).toBe(1)
    expect(topics[0].slug).toBe("test-runner")
    expect(topics[0].text).toBe("- bun only\n- avoid vitest")
  })

  test("returns nothing for prose-only output", () => {
    expect(MemoryExtract.parseExtractionTopics("NOTHING TO REMEMBER")).toEqual([])
    expect(MemoryExtract.parseExtractionTopics("just some notes without slugs")).toEqual([])
  })
})
