import { describe, expect, test } from "bun:test"
import path from "path"
import { MemoryExtract } from "../../src/memory/extract"
import type { SessionV1 } from "@flynncode/core/v1/session"

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

// Regression corpus from the 2026-11-01 cleanup: `consolidated` is the
// hand-merged 13-topic set, `sprawl` and `paraphrased` are files the extractor
// had minted for facts that set already covers, `novel` holds facts it does not.
async function fixture(name: string) {
  const cwd = path.join(import.meta.dir, "fixtures", name)
  return Promise.all(
    [...new Bun.Glob("*.md").scanSync({ cwd })]
      .toSorted()
      .map(async (file) => ({ slug: file.slice(0, -".md".length), text: await Bun.file(path.join(cwd, file)).text() })),
  )
}

describe("buildExtractionPrompt with existing topics", () => {
  test("shows existing slugs with their content and asks to reuse them", async () => {
    const existing = await fixture("consolidated")
    const prompt = MemoryExtract.buildExtractionPrompt({ conversation: "prefers bun", existing })
    for (const topic of existing) expect(prompt).toContain(`SLUG: ${topic.slug}`)
    expect(prompt).toContain("merge completed work to `dev`")
    expect(prompt).toMatch(/use that exact slug/i)
    expect(prompt).toMatch(/placeholder/i)
  })

  test("keeps every slug visible once topic bodies exhaust the budget", () => {
    const existing = Array.from({ length: 40 }, (_, i) => ({ slug: `topic-${i}`, text: `- ${"x".repeat(2000)}` }))
    const prompt = MemoryExtract.buildExtractionPrompt({ conversation: "prefers bun", existing })
    for (const topic of existing) expect(prompt).toContain(`SLUG: ${topic.slug}`)
    expect(prompt.length).toBeLessThan(16_000)
  })

  test("omits the existing-topics section for an empty memories dir", () => {
    expect(MemoryExtract.buildExtractionPrompt({ conversation: "prefers bun" })).not.toContain("Existing topics")
  })
})

describe("curateTopics", () => {
  test("appends new bullets to an existing topic instead of replacing it", () => {
    const topics = MemoryExtract.curateTopics({
      topics: [{ slug: "test-runner", text: "- run e2e with system chrome" }],
      existing: [{ slug: "test-runner", text: "- always use bun\n" }],
      room: 5,
    })
    expect(topics).toEqual([{ slug: "test-runner", text: "- always use bun\n- run e2e with system chrome" }])
  })

  test("drops a fact the memories dir already states, even under a new slug", async () => {
    const topics = MemoryExtract.curateTopics({
      topics: [{ slug: "workflow-habits", text: "- Commit fixes once confirmed and merge completed work to dev" }],
      existing: await fixture("consolidated"),
      room: 5,
    })
    expect(topics).toEqual([])
  })

  test("rejects placeholder bullets and junk slugs", () => {
    const topics = MemoryExtract.curateTopics({
      topics: [
        { slug: "tmp-key", text: "- temporary note about the build" },
        { slug: "other", text: "- prefers ripgrep" },
        { slug: "conventions", text: "- project convention\n- TODO\n- ...\n- run tests from package dirs" },
      ],
      existing: [],
      room: 5,
    })
    expect(topics).toEqual([{ slug: "conventions", text: "- run tests from package dirs" }])
  })

  test("keeps a correction that flips an existing fact", () => {
    const topics = MemoryExtract.curateTopics({
      topics: [{ slug: "test-runner", text: "- never use bun for e2e" }],
      existing: [{ slug: "test-runner", text: "- always use bun for e2e" }],
      room: 5,
    })
    expect(topics[0]?.text).toContain("- never use bun for e2e")
  })

  test("folds restated topics into the consolidated set instead of minting slugs", async () => {
    const existing = await fixture("consolidated")
    const slugs = new Set(existing.map((topic) => topic.slug))
    for (const topic of await fixture("sprawl")) {
      const curated = MemoryExtract.curateTopics({ topics: [topic], existing, room: 5 })
      expect({ slug: topic.slug, minted: curated.map((item) => item.slug).filter((slug) => !slugs.has(slug)) }).toEqual({
        slug: topic.slug,
        minted: [],
      })
    }
  })

  test("gives a novel fact its own topic", async () => {
    const existing = await fixture("consolidated")
    for (const topic of await fixture("novel"))
      expect(MemoryExtract.curateTopics({ topics: [topic], existing, room: 5 }).map((item) => item.slug)).toEqual([
        topic.slug,
      ])
  })

  test("at max_files, folds a would-be new topic into the closest existing one", async () => {
    const existing = await fixture("consolidated")
    for (const topic of await fixture("paraphrased")) {
      const curated = MemoryExtract.curateTopics({ topics: [topic], existing, room: 0 })
      expect(curated.map((item) => item.slug)).toEqual(["user-working-style"])
      expect(curated[0]?.text.startsWith(existing.find((item) => item.slug === "user-working-style")!.text.trimEnd())).toBe(true)
    }
  })

  test("counts topics minted earlier in the same extraction against the room", async () => {
    const existing = await fixture("consolidated")
    const slugs = new Set(existing.map((topic) => topic.slug))
    const curated = MemoryExtract.curateTopics({ topics: await fixture("novel"), existing, room: 1 })
    expect(curated.filter((item) => !slugs.has(item.slug)).map((item) => item.slug)).toEqual(["drizzle-schema"])
  })
})
