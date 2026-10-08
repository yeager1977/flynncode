import { describe, expect, test } from "bun:test"
import { directoryMissing, knowledgeNotesEmpty } from "./new-session-knowledge"

describe("knowledgeNotesEmpty", () => {
  test("empty listing is empty", () => {
    expect(knowledgeNotesEmpty([[]])).toBe(true)
  })

  test("missing listing counts as empty", () => {
    expect(knowledgeNotesEmpty([undefined])).toBe(true)
  })

  test("markdown notes clear the empty state", () => {
    expect(knowledgeNotesEmpty([["onboarding.md"]])).toBe(false)
  })

  test("non-markdown files are ignored", () => {
    expect(knowledgeNotesEmpty([["notes.txt"]])).toBe(true)
  })

  test("notes in any listed folder clear the empty state", () => {
    expect(knowledgeNotesEmpty([[], ["a.md"]])).toBe(false)
  })
})

describe("directoryMissing", () => {
  test("parent listing without the folder proves it missing", () => {
    expect(directoryMissing([".opencode/agents/", ".opencode/config.json"], ".opencode/knowledge")).toBe(true)
  })

  test("a listed directory is present", () => {
    expect(directoryMissing([".opencode/knowledge/"], ".opencode/knowledge")).toBe(false)
  })

  test("windows separators still match", () => {
    expect(directoryMissing([".opencode\\knowledge\\"], ".opencode/knowledge")).toBe(false)
  })
})
