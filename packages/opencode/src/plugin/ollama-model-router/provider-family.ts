import type { CatalogLike } from "./candidates"

export type ModelFamily = "auto" | "ollama" | "openai" | "anthropic"
export type FamilyTier = "flagship" | "balanced" | "balanced-writing" | "fast"

const TIER_MODELS: Record<"openai" | "anthropic", Record<FamilyTier, string>> = {
  openai: {
    flagship: "gpt-6-astra",
    balanced: "gpt-6-sol",
    "balanced-writing": "gpt-6-sol",
    fast: "gpt-6-sol-fast",
  },
  anthropic: {
    flagship: "claude-opus-5-5",
    balanced: "claude-sonnet-5",
    "balanced-writing": "claude-fable-5-1",
    fast: "claude-sonnet-5",
  },
}

export const FAMILY_ORDER: Exclude<ModelFamily, "auto">[] = ["ollama", "openai", "anthropic"]

export function nextFamily(family: Exclude<ModelFamily, "auto">): Exclude<ModelFamily, "auto"> | undefined {
  const index = FAMILY_ORDER.indexOf(family)
  if (index < 0 || index === FAMILY_ORDER.length - 1) return undefined
  return FAMILY_ORDER[index + 1]
}

export function familyProviders(family: Exclude<ModelFamily, "auto">): string[] {
  if (family === "ollama") return ["ollama"]
  if (family === "openai") return ["openai", "github-copilot", "vercel", "opencode"]
  return ["anthropic", "anthropic-api", "opencode", "vercel"]
}

export function resolveFamilyModel(input: {
  family: Exclude<ModelFamily, "auto">
  tier: FamilyTier
  catalog: CatalogLike
  available: Set<string>
}): string | undefined {
  if (input.family === "ollama") return undefined
  const model = TIER_MODELS[input.family][input.tier]
  for (const providerID of familyProviders(input.family)) {
    const entry = input.catalog[providerID]
    if (!entry?.models?.[model]) continue
    const key = `${providerID}/${model}`
    if (input.available.size > 0 && !input.available.has(key)) continue
    return key
  }
  return undefined
}