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

  test("deepseek or glm chains keep their deepseek rungs", () => {
    for (const name of ["quick", "unspecified-low"]) {
      const chain = fallbackChain("category", name)
      expect(chain.some((entry) => entry.model.includes("deepseek"))).toBe(true)
    }
    expect(fallbackChain("category", "quick")[0]?.model).toBe("gpt-6-luna")
    expect(fallbackChain("category", "unspecified-low")[0]?.model).toBe("gpt-5.6-terra")
  })
})

describe("fallbackLabel", () => {
  test("quick resolves to a live fast-lane entry", () => {
    const chain = fallbackChain("category", "quick")
    expect(fallbackLabel(chain, new Set(["opencode"]))).toEqual({
      model: "opencode/gpt-6-luna",
      connected: true,
    })
  })

  test("sisyphus head is gpt-6-astra when nothing is connected", () => {
    expect(fallbackLabel(fallbackChain("agent", "sisyphus"), new Set())).toEqual({
      model: "anthropic/gpt-6-astra",
      connected: false,
    })
  })

  test("skips a connected provider that does not serve the entry model", () => {
    const chain: { providers: string[]; model: string }[] = [
      { providers: ["anthropic", "openai"], model: "gpt-6-astra" },
      { providers: ["openai"], model: "gpt-6-sol" },
    ]
    const models = new Map([
      ["anthropic", new Set(["claude-sonnet-5"])],
      ["openai", new Set(["gpt-6-astra", "gpt-6-sol"])],
    ])
    // anthropic is connected but does not serve gpt-6-astra; openai does,
    // so the same rung resolves through openai.
    expect(fallbackLabel(chain, new Set(["anthropic", "openai"]), models)).toEqual({
      model: "openai/gpt-6-astra",
      connected: true,
    })
  })

  test("walks to the next rung when a head provider is connected but does not serve the model", () => {
    const chain: { providers: string[]; model: string }[] = [
      { providers: ["anthropic"], model: "gpt-6-astra" },
      { providers: ["anthropic"], model: "claude-sonnet-5" },
    ]
    const models = new Map([["anthropic", new Set(["claude-sonnet-5"])]])
    expect(fallbackLabel(chain, new Set(["anthropic"]), models)).toEqual({
      model: "anthropic/claude-sonnet-5",
      connected: true,
    })
  })

  test("reports offline when connected providers serve none of the chain", () => {
    const chain: { providers: string[]; model: string }[] = [{ providers: ["anthropic"], model: "gpt-6-astra" }]
    const models = new Map([["anthropic", new Set(["claude-sonnet-5"])]] as const)
    expect(fallbackLabel(chain, new Set(["anthropic"]), models as ReadonlyMap<string, ReadonlySet<string>>)).toEqual({
      model: "anthropic/gpt-6-astra",
      connected: false,
    })
  })
})
