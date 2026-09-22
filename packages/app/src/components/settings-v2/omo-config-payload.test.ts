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

describe("fallbackLabel", () => {
  test("quick names the xAI grok entry when xAI is connected", () => {
    expect(fallbackChain("category", "quick").some((entry) => entry.providers.includes("xai"))).toBe(true)
    expect(fallbackLabel(fallbackChain("category", "quick"), new Set(["xai"]))).toEqual({
      model: "xai/grok-4.20-0309-non-reasoning",
      connected: true,
    })
  })

  test("sisyphus head is claude-opus-5 when nothing is connected", () => {
    expect(fallbackLabel(fallbackChain("agent", "sisyphus"), new Set())).toEqual({
      model: "anthropic/claude-opus-5",
      connected: false,
    })
  })
})
