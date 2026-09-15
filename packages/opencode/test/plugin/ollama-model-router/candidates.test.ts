import { describe, expect, test } from "bun:test"
import { collectCandidates, collectMeta, findUnmatchedScorecardKeys } from "../../../src/plugin/ollama-model-router/candidates"
import { parseOptions } from "../../../src/plugin/ollama-model-router/scorecard"

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
    const cfgWithLocal = {
      ...cfg,
      provider: {
        ...cfg.provider,
        "ollama-local": { models: { "llama3.1:8b": { name: "Llama 3.1 8B" } } },
      },
    }
    const list = collectCandidates(cfgWithLocal, options({ providers: ["ollama-cloud", "ollama-local"] }))
    const local = list.find((c) => c.key === "ollama-local/llama3.1:8b")
    expect(local).toBeDefined()
    expect(local?.providerDisabled).toBe(true)
    const cloud = list.find((c) => c.key === "ollama-cloud/gpt-oss:20b")
    expect(cloud?.providerDisabled).toBe(false)
  })

  test("defaults to providers whose id starts with ollama", () => {
    const list = collectCandidates(cfg, options({ providers: undefined }))
    expect(list.every((c) => c.providerID.startsWith("ollama"))).toBe(true)
    expect(list.find((c) => c.key === "openai/gpt-5")).toBeUndefined()
  })

  test("findUnmatchedScorecardKeys reports scorecard keys with no live model", () => {
    const opts = options({ models: { "ollama-cloud/nope": { price: 1, capability: 1, speed: 1 }, "ollama-cloud/gpt-oss:20b": { price: 2, capability: 2, speed: 2 } } })
    const unmatched = findUnmatchedScorecardKeys(cfg, opts)
    expect(unmatched).toEqual(["ollama-cloud/nope"])
  })

  test("collectMeta extracts name, context, and capability flags", () => {
    const meta = collectMeta(cfg, options())
    const hit = meta.get("ollama-cloud/glm-5.3-flash:cloud")
    expect(hit?.name).toBe("GLM 5.3 Flash")
    expect(hit?.context).toBe(1000000)
    expect(hit?.toolCall).toBe(true)
    expect(hit?.reasoning).toBe(false)
    expect(hit?.providerDisabled).toBe(false)
  })
})
