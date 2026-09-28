import type { CatalogLike } from "./candidates"
import type { TaskName } from "./types"

export type ModelFamily = "auto" | "ollama" | "openai" | "anthropic"
export type FamilyTier = "flagship" | "balanced" | "balanced-writing" | "fast"

export const MODEL_FAMILIES: ModelFamily[] = ["auto", "ollama", "openai", "anthropic"]

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

// Where each routing task sits in the family tier ladder. Coding and planning
// stay on the day-to-day tier; review and architecture reserve the flagship.
const TASK_TIERS: Record<TaskName, FamilyTier> = {
  coding: "balanced",
  planning: "balanced-writing",
  review: "flagship",
  architecture: "flagship",
  lookup: "fast",
  writing: "balanced-writing",
  "long-context": "fast",
}

export function taskFamilyTier(task: TaskName): FamilyTier {
  return TASK_TIERS[task]
}

export function resolveFamilyModel(input: {
  family: Exclude<ModelFamily, "auto">
  tier: FamilyTier
  catalog: CatalogLike
  available: Set<string>
}): string | undefined {
  // Legacy hand-built options (tests, external loaders) predate modelFamily and
  // carry undefined; treat it like "auto" so ranking never touches the tiers.
  if (input.family === "ollama" || !input.family) return undefined
  const tierModels = TIER_MODELS[input.family]
  if (!tierModels) return undefined
  const model = tierModels[input.tier]
  if (!model) return undefined
  for (const providerID of familyProviders(input.family)) {
    const entry = input.catalog[providerID]
    if (!entry?.models?.[model]) continue
    const key = `${providerID}/${model}`
    if (input.available.size > 0 && !input.available.has(key)) continue
    return key
  }
  return undefined
}