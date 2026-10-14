import { describe, expect, test } from "bun:test"
import { visibilityExcludeKeys, visibilityUnchanged } from "./models"

describe("visibility exclude mirror", () => {
  test("mirrors explicit hides only", () => {
    const rows: Array<{ providerID: string; modelID: string; visibility: "show" | "hide" }> = [
      { providerID: "anthropic", modelID: "claude-sonnet-5", visibility: "show" },
      { providerID: "anthropic", modelID: "claude-opus-5", visibility: "hide" },
      { providerID: "openai", modelID: "gpt-6-sol", visibility: "hide" },
    ]
    expect(visibilityExcludeKeys(rows)).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-6-sol",
    ])
  })

  test("empty store produces an empty mirror", () => {
    expect(visibilityExcludeKeys([])).toEqual([])
  })

  test("unchanged when the configured list matches as a set", () => {
    expect(visibilityUnchanged(["openai/gpt-6-sol", "anthropic/claude-opus-5"], ["anthropic/claude-opus-5", "openai/gpt-6-sol"])).toBe(true)
  })

  test("changed when the list differs, or is undefined/non-string", () => {
    expect(visibilityUnchanged(["openai/gpt-6-sol"], [])).toBe(false)
    expect(visibilityUnchanged(undefined, [])).toBe(false)
    expect(visibilityUnchanged(["openai/gpt-6-sol", 42], ["openai/gpt-6-sol"])).toBe(false)
    expect(visibilityUnchanged(["openai/gpt-6-sol"], ["openai/gpt-6-sol"])).toBe(true)
  })
})
