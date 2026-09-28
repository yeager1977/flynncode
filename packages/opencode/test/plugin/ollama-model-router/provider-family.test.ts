import { describe, expect, test } from "bun:test"
import {
  nextFamily,
  resolveFamilyModel,
  taskFamilyTier,
} from "../../../src/plugin/ollama-model-router/provider-family"

const catalog = {
  openai: { id: "openai", models: { "gpt-6-astra": {}, "gpt-6-sol": {}, "gpt-6-luna-fast": {} } },
  anthropic: { id: "anthropic", models: { "claude-opus-5-5": {}, "claude-sonnet-5": {} } },
  "ollama-cloud": { id: "ollama-cloud", models: { "glm-5.3-flash": {} } },
}

describe("nextFamily", () => {
  test("falls through ollama, openai, anthropic", () => {
    expect(nextFamily("ollama")).toBe("openai")
    expect(nextFamily("openai")).toBe("anthropic")
    expect(nextFamily("anthropic")).toBeUndefined()
  })
})

describe("resolveFamilyModel", () => {
  test("picks the tier model from the selected family", () => {
    const available = new Set(["openai/gpt-6-sol"])
    expect(resolveFamilyModel({ family: "openai", tier: "balanced", catalog, available })).toBe("openai/gpt-6-sol")
  })

  test("returns undefined when the family lacks the tier", () => {
    const available = new Set<string>()
    expect(resolveFamilyModel({ family: "ollama", tier: "flagship", catalog, available })).toBeUndefined()
  })
})

describe("taskFamilyTier", () => {
  test("maps every task to its family tier", () => {
    expect(taskFamilyTier("coding")).toBe("balanced")
    expect(taskFamilyTier("planning")).toBe("balanced-writing")
    expect(taskFamilyTier("review")).toBe("flagship")
    expect(taskFamilyTier("architecture")).toBe("flagship")
    expect(taskFamilyTier("lookup")).toBe("fast")
    expect(taskFamilyTier("writing")).toBe("balanced-writing")
    expect(taskFamilyTier("long-context")).toBe("fast")
  })
})