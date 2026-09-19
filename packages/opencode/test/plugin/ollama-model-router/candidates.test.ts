import { describe, expect, test } from "bun:test"
import { collectCandidates, collectMeta, findUnmatchedScorecardKeys } from "../../../src/plugin/ollama-model-router/candidates"
import { rankModels } from "../../../src/plugin/ollama-model-router/rank"
import { DEFAULT_TASK_WEIGHTS, parseOptions } from "../../../src/plugin/ollama-model-router/scorecard"

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
    expect(unmatched).toContain("ollama-cloud/nope")
    expect(unmatched.filter((key) => key.startsWith("xai/"))).toEqual([
      "xai/grok-4.6",
      "xai/grok-4.5",
      "xai/grok-4.20-0309-reasoning",
      "xai/grok-4.20-0309-non-reasoning",
      "xai/grok-4.3",
      "xai/grok-build-0.1",
    ])
  })

  test("marks models listed in excludeModels as hidden", () => {
    const list = collectCandidates(cfg, options({ excludeModels: ["ollama-cloud/gpt-oss:20b"] }))
    expect(list.find((c) => c.key === "ollama-cloud/gpt-oss:20b")?.hidden).toBe(true)
    expect(list.find((c) => c.key === "ollama-cloud/glm-5.3-flash:cloud")?.hidden).toBe(false)
  })

  test("xAI models appear only when xai is in providers", () => {
    const xaiCfg = {
      provider: {
        ...cfg.provider,
        xai: {
          models: {
            "grok-4.6": {},
            "grok-4.5": {},
            "grok-4.20-0309-reasoning": {},
            "grok-4.20-0309-non-reasoning": {},
            "grok-4.3": {},
            "grok-build-0.1": {},
            "grok-4.20-multi-agent-0309": {},
            "grok-imagine-image": {},
            "grok-imagine-video": {},
            "grok-imagine-video-1.5": {},
          },
        },
      },
    }
    const scored = [
      "xai/grok-4.6",
      "xai/grok-4.5",
      "xai/grok-4.20-0309-reasoning",
      "xai/grok-4.20-0309-non-reasoning",
      "xai/grok-4.3",
      "xai/grok-build-0.1",
    ]
    const without = collectCandidates(xaiCfg, options())
    expect(without.some((c) => c.providerID === "xai")).toBe(false)
    const withXai = collectCandidates(xaiCfg, options({ providers: ["xai"] }))
    expect(scored.every((key) => withXai.some((c) => c.key === key && c.entry))).toBe(true)
  })

  test("bundled non-agentic Grok models are not routable when allowUnscored is false", () => {
    const xaiCfg = {
      provider: {
        xai: {
          models: {
            "grok-4.6": {},
            "grok-4.20-multi-agent-0309": {},
            "grok-imagine-image": {},
            "grok-imagine-video": {},
            "grok-imagine-video-1.5": {},
          },
        },
      },
    }
    const opts = options({ providers: ["xai"], allowUnscored: false })
    const result = rankModels(collectCandidates(xaiCfg, opts), "coding", DEFAULT_TASK_WEIGHTS.coding, {
      allowUnscored: false,
    })
    expect(result.ranked.map((r) => r.key)).toEqual(["xai/grok-4.6"])
    expect(result.excluded.map((r) => r.key).sort()).toEqual([
      "xai/grok-4.20-multi-agent-0309",
      "xai/grok-imagine-image",
      "xai/grok-imagine-video",
      "xai/grok-imagine-video-1.5",
    ])
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
