import { describe, expect, it } from "bun:test"
import { buildOptions, toggleSelection } from "../src/import/selection"
import type { SourceCandidate } from "../src/import/discover"

const candidate = (id: string): SourceCandidate => ({
  path: `/tmp/${id}.jsonl`,
  source: "codex",
  sourceSessionID: id,
  title: `title ${id}`,
  cwd: "/work",
  time: 1,
  messageCount: 2,
})

describe("import selection", () => {
  it("toggles membership", () => {
    const first = toggleSelection(new Set<string>(), "a")
    expect([...first]).toEqual(["a"])
    const second = toggleSelection(first, "a")
    expect([...second]).toEqual([])
  })

  it("marks already imported sessions as disabled", () => {
    const options = buildOptions([candidate("a"), candidate("b")], new Set(["a"]))
    expect(options.map((option) => option.disabled)).toEqual([true, false])
  })

  it("exposes the candidate on each option", () => {
    const options = buildOptions([candidate("a")], new Set())
    expect(options[0]?.value).toMatchObject({ sourceSessionID: "a" })
  })
})