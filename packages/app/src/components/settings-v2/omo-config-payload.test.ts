import { describe, expect, test } from "bun:test"
import { fallbackLabel, openCodeBans, pluginPatch } from "./omo-config-payload"
import { fallbackChain } from "./omo-catalog"

const base = {
  scope: "global" as const,
  shownProviders: ["xai", "ollama-cloud"],
  checked: ["xai"],
  hiddenBans: ["ollama-local"],
  globalOpenCodeBans: ["ollama-local"],
  globalPluginBans: ["ollama-local"],
  agents: { sisyphus: { model: "ollama-cloud/glm-5.3", variant: "high" } as const },
  categories: { quick: "automatic" as const },
  existingAgents: { sisyphus: { temperature: 0.2, model: "openai/gpt-5.6-sol" } },
  existingCategories: {},
}

describe("pluginPatch", () => {
  test("writes a pin and drops an automatic model without dropping other keys", () => {
    const patch = pluginPatch({ ...base, categories: { quick: "automatic" } })
    expect(patch.agents.sisyphus).toEqual({ temperature: 0.2, model: "ollama-cloud/glm-5.3", variant: "high" })
    expect(patch.categories.quick).toBeNull()
  })

  test("project inherit omits the key and plugin bans are extras only", () => {
    const patch = pluginPatch({
      ...base,
      scope: "project",
      agents: { sisyphus: "inherit" },
      checked: ["xai", "ollama-local"],
    })
    expect(patch.agents.sisyphus).toBeNull()
    expect(patch.disabledProviders).toEqual(["xai"])
  })

  test("global file keeps a banned id the form did not show", () => {
    expect(pluginPatch(base).disabledProviders).toEqual(["ollama-local", "xai"])
  })
})

describe("openCodeBans", () => {
  test("project file keeps global bans", () => {
    expect(openCodeBans({ ...base, scope: "project", checked: ["xai", "ollama-local"] })).toEqual([
      "ollama-local",
      "xai",
    ])
  })

  test("keeps a banned id the form did not show", () => {
    expect(openCodeBans(base)).toEqual(["ollama-local", "xai"])
  })
})

describe("omo catalog gpt-6 baseline", () => {
  test("chains without deepseek or glm lead with a gpt-6 model", () => {
    const converted = ["visual-engineering", "ultrabrain", "deep", "artistry", "unspecified-high", "writing"]
    for (const name of converted) {
      const chain = fallbackChain("category", name)
      expect(chain[0]?.model).toMatch(/^gpt-6/)
    }
  })

  test("deepseek or glm chains stay untouched", () => {
    for (const name of ["quick", "unspecified-low"]) {
      const chain = fallbackChain("category", name)
      expect(chain.some((entry) => entry.model.includes("deepseek"))).toBe(true)
      expect(chain[0]?.model).not.toMatch(/^gpt-6/)
    }
  })
})

describe("fallbackLabel", () => {
  test("quick names the xAI grok entry when xAI is connected", () => {
    expect(fallbackChain("category", "quick").some((entry) => entry.providers.includes("xai"))).toBe(true)
    expect(fallbackLabel(fallbackChain("category", "quick"), new Set(["xai"]))).toEqual({
      model: "xai/grok-4.20-0309-non-reasoning",
      connected: true,
    })
  })

  test("sisyphus head is gpt-6-astra when nothing is connected", () => {
    expect(fallbackLabel(fallbackChain("agent", "sisyphus"), new Set())).toEqual({
      model: "anthropic/gpt-6-astra",
      connected: false,
    })
  })
})
