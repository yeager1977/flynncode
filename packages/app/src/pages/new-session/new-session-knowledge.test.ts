import { describe, expect, test } from "bun:test"
import { knowledgeNotesEmpty } from "./new-session-knowledge"

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
