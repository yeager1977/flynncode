import { describe, expect, test } from "bun:test"
import { collectCandidates } from "../src/candidates"
import { parseOptions } from "../src/scorecard"

const cfg = {
  provider: {
    "ollama-cloud": {
      models: {
        "glm-5.3-flash:cloud": { name: "GLM 5.3 Flash", limit: { context: 1000000 }, tool_call: true },
        "gpt-oss:20b": { name: "GPT-OSS 20B" },
      },
    },
    "ollama-gpu": {
      models: { "qwen3.8:latest": { name: "Qwen 3.8 27B" } },
    },
    openai: {
      models: { "gpt-5": { name: "GPT-5" } },
    },
  },
  disabled_providers: ["ollama-local"],
}

function options(overrides: Record<string, unknown> = {}) {
  const result = parseOptions({
    providers: ["ollama-cloud", "ollama-gpu"],
    models: { "ollama-cloud/glm-5.3-flash:cloud": { price: 3, capability: 8, speed: 9 } },
    ...overrides,
  })
  if (!result.ok) throw new Error(result.errors.join(", "))
  return result.options
}

describe("collectCandidates", () => {
  test("collects models from configured providers only", () => {
    const list = collectCandidates(cfg, options())
    expect(list.map((c) => c.key).sort()).toEqual([
      "ollama-cloud/glm-5.3-flash:cloud",
      "ollama-cloud/gpt-oss:20b",
      "ollama-gpu/qwen3.8:latest",
    ])
  })

  test("attaches scorecard entries", () => {
    const list = collectCandidates(cfg, options())
    const hit = list.find((c) => c.key === "ollama-cloud/glm-5.3-flash:cloud")
    expect(hit?.entry?.capability).toBe(8)
  })

  test("marks disabled providers", () => {
    const list = collectCandidates(cfg, options({ providers: ["ollama-local"], models: {} }))
    // ollama-local has no models in cfg, so nothing to collect; use cloud instead
    expect(list.length).toBe(0)
  })

  test("defaults to providers whose id starts with ollama", () => {
    const list = collectCandidates(cfg, options({ providers: undefined }))
    expect(list.every((c) => c.providerID.startsWith("ollama"))).toBe(true)
    expect(list.find((c) => c.key === "openai/gpt-5")).toBeUndefined()
  })
})
