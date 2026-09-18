import { describe, expect, it } from "bun:test"
import { buildOptions, tally, toggleSelection, type ImportCandidate } from "./import-selection"

const candidate = (id: string, imported = false): ImportCandidate => ({
  path: `/tmp/${id}.jsonl`,
  sourceSessionID: id,
  title: `title ${id}`,
  cwd: "/work",
  time: 1,
  messageCount: 2,
  imported,
})

describe("import selection", () => {
  it("toggles membership", () => {
    const first = toggleSelection(new Set<string>(), "a")
    expect([...first]).toEqual(["a"])
    expect([...toggleSelection(first, "a")]).toEqual([])
  })

  it("marks imported rows as disabled", () => {
    const options = buildOptions([candidate("a", true), candidate("b")], "title")
    expect(options.map((option) => option.disabled)).toEqual([true, false])
  })

  it("filters by title and source session id", () => {
    const options = buildOptions([candidate("alpha"), candidate("beta")], "bet")
    expect(options.map((option) => option.value.sourceSessionID)).toEqual(["beta"])
  })

  it("summarises counts", () => {
    expect(tally([true, true, true, false])).toEqual({ imported: 3, failed: 1 })
  })
})