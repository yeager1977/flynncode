import { describe, expect, it } from "bun:test"
import {
  buildOptions,
  clearVisible,
  selectAll,
  selectedCount,
  tally,
  toggleSelection,
  type ImportCandidate,
} from "./import-selection"

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

  it("selects all selectable options but not imported ones", () => {
    const options = buildOptions([candidate("a"), candidate("b", true), candidate("c")], "")
    const next = selectAll(new Set<string>(["keep"]), options)
    expect([...next].sort()).toEqual(["a", "c", "keep"])
  })

  it("clears only the visible options and keeps other picks", () => {
    const options = buildOptions([candidate("a"), candidate("b")], "")
    const next = clearVisible(new Set<string>(["a", "b", "outside"]), options)
    expect([...next]).toEqual(["outside"])
  })

  it("counts only selectable selected options", () => {
    const options = buildOptions([candidate("a"), candidate("b", true), candidate("c")], "")
    expect(selectedCount(new Set<string>(["a", "b", "c"]), options)).toBe(2)
  })
})