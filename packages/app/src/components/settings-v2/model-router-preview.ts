import {
  DEFAULT_TASK_WEIGHTS,
  type ModelFamily,
  type ModelRouterFormState,
  type TaskName,
  type TaskWeights,
} from "./model-router-payload"

// Mirrors the plugin's provider-family contract (contract tests keep the two
// in sync); the app bundle cannot import opencode-internal modules.
type FamilyTier = "flagship" | "balanced" | "balanced-writing" | "fast"

const APP_TIER_MODELS: Record<"openai" | "anthropic", Record<FamilyTier, string>> = {
  openai: {
    flagship: "gpt-6-astra",
    balanced: "gpt-6-sol",
    "balanced-writing": "gpt-6-sol",
    fast: "gpt-6-luna",
  },
  anthropic: {
    flagship: "claude-opus-5-5",
    balanced: "claude-sonnet-5",
    "balanced-writing": "claude-fable-5-1",
    fast: "claude-sonnet-5",
  },
}

const APP_TASK_TIERS: Record<TaskName, FamilyTier> = {
  coding: "balanced",
  planning: "balanced-writing",
  review: "flagship",
  architecture: "flagship",
  lookup: "fast",
  writing: "balanced-writing",
  "long-context": "fast",
}

const APP_FAMILY_ORDER: Exclude<ModelFamily, "auto">[] = ["ollama", "openai", "anthropic"]

const APP_FAMILY_PROVIDERS: Record<Exclude<ModelFamily, "auto">, string[]> = {
  ollama: ["ollama"],
  openai: ["openai", "github-copilot", "vercel", "opencode"],
  anthropic: ["anthropic", "anthropic-api", "opencode", "vercel"],
}

// Same walk the plugin does at runtime: the selected family's tier model
// first, then FAMILY_ORDER. An explicit providers list suppresses the family
// scope, matching candidates.ts.
function previewFamilyWinner(form: ModelRouterFormState, catalog: RouterModel[], task: TaskName) {
  if (form.modelFamily === "auto" || form.providers.length > 0) return undefined
  const tierModels = form.modelFamily === "ollama" ? undefined : APP_TIER_MODELS[form.modelFamily]
  if (!tierModels) return undefined
  const model = tierModels[APP_TASK_TIERS[task]]
  if (!model) return undefined
  for (const family of [form.modelFamily, ...APP_FAMILY_ORDER.filter((f) => f !== form.modelFamily)]) {
    const tierModel = family === form.modelFamily ? model : APP_TIER_MODELS[family as "openai" | "anthropic"]?.[APP_TASK_TIERS[task]]
    if (!tierModel) continue
    for (const providerID of APP_FAMILY_PROVIDERS[family]) {
      const entry = catalog.find((candidate) => candidate.key === `${providerID}/${tierModel}`)
      if (!entry || entry.disabled || !entry.enabled) continue
      return entry.key
    }
  }
  return undefined
}

export type RouterSource = {
  provider?: Record<string, { name?: string; models?: Record<string, { name?: string }> } | undefined>
  disabled_providers?: string[]
}

export type RouterModel = {
  key: string
  name: string
  providerID: string
  provider: string
  disabled: boolean
  enabled: boolean
}

// `isEnabled` comes from the Manage Models visibility store. It is optional so
// pure callers (and the plugin contract test) see the full provider catalog.
export function routerCatalog(
  source: RouterSource,
  isEnabled?: (providerID: string, modelID: string) => boolean,
): RouterModel[] {
  return Object.entries(source.provider ?? {}).flatMap(([providerID, provider]) =>
    Object.entries(provider?.models ?? {}).map(([modelID, model]) => ({
      key: `${providerID}/${modelID}`,
      name: model.name ?? modelID,
      providerID,
      provider: provider?.name ?? providerID,
      disabled: source.disabled_providers?.includes(providerID) ?? false,
      enabled: isEnabled ? isEnabled(providerID, modelID) : true,
    })),
  )
}

export function modelAvailability(form: ModelRouterFormState, model: RouterModel | undefined) {
  if (!model) return "missing"
  if (model.disabled) return "disabled"
  if (form.providers.length ? !form.providers.includes(model.providerID) : !model.providerID.startsWith("ollama")) {
    return "provider"
  }
  if (!model.enabled) return "hidden"
  return "available"
}

// This is an advisory draft preview, not a runtime assignment. Contract tests
// compare it with the plugin so server code never enters the browser bundle.
export function previewTask(form: ModelRouterFormState, catalog: RouterModel[], task: TaskName) {
  const scores = new Map(form.models.map((model) => [model.key, model]))
  const weights = normalized(form.taskWeights[task])
  const pinned = form.taskModels[task]
  const familyWinner = previewFamilyWinner(form, catalog, task)
  return catalog
    .filter((model) => modelAvailability(form, model) === "available")
    .flatMap((model) => {
      const entry = scores.get(model.key)
      const isPinned = pinned === model.key
      const isFamilyWinner = familyWinner === model.key
      // The plugin ranks the pin and the model_family winner even when they
      // are unscored or tagged away.
      if (!isPinned && !isFamilyWinner) {
        if (!entry && !form.allowUnscored) return []
        if (entry?.tags.length && !entry.tags.includes(task)) return []
      } else if (pinnedIndex(pinned, model.key) !== -1) {
        return []
      } else if (isFamilyWinner && pinned) {
        return []
      }
      const value = entry ?? { capability: 5, price: 5, speed: 5 }
      return [
        {
          model,
          score:
            weights.capability * value.capability + weights.price * (10 - value.price) + weights.speed * value.speed,
        },
      ]
    })
    .sort(
      (a, b) =>
        pinnedIndex(pinned, a.model.key) - pinnedIndex(pinned, b.model.key) ||
        winnerIndex(familyWinner, a.model.key) - winnerIndex(familyWinner, b.model.key) ||
        b.score - a.score ||
        (scores.get(a.model.key)?.price ?? 10) - (scores.get(b.model.key)?.price ?? 10) ||
        (scores.get(b.model.key)?.speed ?? 0) - (scores.get(a.model.key)?.speed ?? 0) ||
        a.model.key.localeCompare(b.model.key),
    )
}

function pinnedIndex(pinned: string | undefined, key: string) {
  return pinned === key ? -1 : 0
}

function winnerIndex(winner: string | undefined, key: string) {
  return winner === key ? -1 : 0
}

export const PRIORITIES = ["recommended", "balanced", "quality", "cost", "speed"] as const
export type Priority = (typeof PRIORITIES)[number]

export function priorityWeights(task: TaskName, priority: Priority) {
  if (priority === "recommended") return { ...DEFAULT_TASK_WEIGHTS[task] }
  if (priority === "quality") return { capability: 0.8, price: 0.1, speed: 0.1 }
  if (priority === "cost") return { capability: 0.25, price: 0.65, speed: 0.1 }
  if (priority === "speed") return { capability: 0.2, price: 0.1, speed: 0.7 }
  return { capability: 1, price: 1, speed: 1 }
}

export function selectedPriority(task: TaskName, weights: TaskWeights[TaskName]) {
  const value = normalized(weights)
  return (
    PRIORITIES.find((priority) => {
      const target = normalized(priorityWeights(task, priority))
      return (Object.keys(value) as (keyof typeof value)[]).every(
        (key) => Math.abs(value[key] - target[key]) < 0.000001,
      )
    }) ?? "custom"
  )
}

export function parseWeight(value: string) {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function normalized(weights: TaskWeights[TaskName]) {
  const total = weights.capability + weights.price + weights.speed
  if (total <= 0) return { capability: 1 / 3, price: 1 / 3, speed: 1 / 3 }
  return { capability: weights.capability / total, price: weights.price / total, speed: weights.speed / total }
}
