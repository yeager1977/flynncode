import { describe, expect, test } from "bun:test"
import { toolSearchCard } from "../../session-ui/src/components/tool-search-card"

describe("toolSearchCard", () => {
  test("lists loaded tool ids as-is", () => {
    expect(toolSearchCard({ query: "select:a_b", loaded: ["github_create_issue", "github_list_prs"] })).toEqual({
      kind: "loaded",
      count: 2,
      names: ["github_create_issue", "github_list_prs"],
      more: 0,
    })
  })

  test("keeps the singular case as one tool", () => {
    expect(toolSearchCard({ query: "x", loaded: ["a_b"] })).toEqual({
      kind: "loaded",
      count: 1,
      names: ["a_b"],
      more: 0,
    })
  })

  test("truncates long lists to the first five", () => {
    const loaded = ["a", "b", "c", "d", "e", "f", "g"]
    expect(toolSearchCard({ query: "x", loaded })).toEqual({
      kind: "loaded",
      count: 7,
      names: ["a", "b", "c", "d", "e"],
      more: 2,
    })
  })

  test("reports the query when nothing matched", () => {
    expect(toolSearchCard({ query: "calendar", loaded: [] })).toEqual({ kind: "none", query: "calendar" })
  })

  test("falls back to the tool input query and ignores malformed metadata", () => {
    expect(toolSearchCard({ loaded: "nope" }, { query: "from input" })).toEqual({ kind: "none", query: "from input" })
    expect(toolSearchCard({ query: "q", loaded: ["a", 1, null, "b"] })).toEqual({
      kind: "loaded",
      count: 2,
      names: ["a", "b"],
      more: 0,
    })
  })
})
