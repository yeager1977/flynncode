import { describe, expect, test } from "bun:test"
import { visibilityExcludeKeys, visibilityUnchanged, visibilityWrite } from "./models"

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

  test("changed when the list differs, or is non-string", () => {
    expect(visibilityUnchanged(["openai/gpt-6-sol"], [])).toBe(false)
    expect(visibilityUnchanged(["openai/gpt-6-sol", 42], ["openai/gpt-6-sol"])).toBe(false)
    expect(visibilityUnchanged(["openai/gpt-6-sol", 42], ["openai/gpt-6-sol", "anthropic/claude-opus-5"])).toBe(false)
    expect(visibilityUnchanged(["openai/gpt-6-sol"], ["openai/gpt-6-sol"])).toBe(true)
  })

  test("an absent list is unchanged only against an empty mirror (absent === empty)", () => {
    expect(visibilityUnchanged(undefined, [])).toBe(true)
    expect(visibilityUnchanged(undefined, ["a/b"])).toBe(false)
  })
})

describe("visibility write decision", () => {
  test("no model_router block: never creates the subtree, even with hides", () => {
    expect(visibilityWrite(undefined, [])).toBeUndefined()
    expect(visibilityWrite(undefined, ["anthropic/claude-opus-5"])).toBeUndefined()
  })

  test("model_router present without excludeModels and nothing hidden: no write", () => {
    expect(visibilityWrite({}, [])).toBeUndefined()
  })

  test("model_router present without excludeModels and something hidden: writes, spreading the router", () => {
    expect(visibilityWrite({ enabled: true } as never, ["anthropic/claude-opus-5"])).toEqual({
      model_router: { enabled: true, excludeModels: ["anthropic/claude-opus-5"] },
    })
  })

  test("model_router with a matching excludeModels list: no write", () => {
    expect(visibilityWrite({ excludeModels: ["anthropic/claude-opus-5"] }, ["anthropic/claude-opus-5"])).toBeUndefined()
  })

  test("a corrupt (non-string) excludeModels list is rewritten", () => {
    expect(visibilityWrite({ excludeModels: ["anthropic/claude-opus-5", 42] }, ["anthropic/claude-opus-5"])).toEqual({
      model_router: { excludeModels: ["anthropic/claude-opus-5"] },
    })
  })
})
