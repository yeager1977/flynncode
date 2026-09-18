import type { ModelMeta, RouterOptions } from "./types"
import type { Candidate } from "./rank"

type ProviderLike = {
  models?: Record<string, unknown>
}

type ConfigLike = {
  provider?: Record<string, ProviderLike | undefined>
  disabled_providers?: string[]
}

// The resolved connected-provider catalog (`Provider.list()` shape). It covers
// models.dev providers (Anthropic, OpenAI, ...) that never appear in raw config
// `provider.*.models`.
export type CatalogLike = Record<string, ProviderLike | undefined>

type ModelEntryLike = {
  name?: unknown
  tool_call?: unknown
  capability?: { toolcall?: unknown; reasoning?: unknown }
  reasoning?: unknown
  limit?: { context?: unknown }
}

type ProviderModelEntry = { key: string; providerID: string; modelID: string; raw: ModelEntryLike }

function selected(options: RouterOptions) {
  return (providerID: string) => {
    if (options.providers.length > 0) return options.providers.includes(providerID)
    return providerID.startsWith("ollama")
  }
}

// Raw config providers are the fallback; the connected catalog wins when given
// because it is the same source the app model picker and provider API use.
function providerSources(cfg: ConfigLike, catalog?: CatalogLike) {
  return Object.entries(catalog ?? cfg.provider ?? {})
}

function collectModels(cfg: ConfigLike, options: RouterOptions, catalog?: CatalogLike): ProviderModelEntry[] {
  const isSelected = selected(options)
  const out: ProviderModelEntry[] = []
  for (const [providerID, provider] of providerSources(cfg, catalog)) {
    if (providerID === ROUTER_PROVIDER_ID) continue
    if (!provider || !provider.models) continue
    if (!isSelected(providerID)) continue
    for (const [modelID, raw] of Object.entries(provider.models)) {
      out.push({ key: `${providerID}/${modelID}`, providerID, modelID, raw: (raw ?? {}) as ModelEntryLike })
    }
  }
  return out
}

export function collectMeta(
  cfg: ConfigLike,
  options: RouterOptions,
  catalog?: CatalogLike,
): Map<string, ModelMeta> {
  const disabled = new Set(cfg.disabled_providers ?? [])
  const meta = new Map<string, ModelMeta>()
  for (const entry of collectModels(cfg, options, catalog)) {
    meta.set(entry.key, {
      providerID: entry.providerID,
      modelID: entry.modelID,
      name: typeof entry.raw.name === "string" ? entry.raw.name : undefined,
      context: typeof entry.raw.limit?.context === "number" ? entry.raw.limit.context : undefined,
      toolCall: entry.raw.tool_call === true || entry.raw.capability?.toolcall === true,
      reasoning: entry.raw.reasoning === true || entry.raw.capability?.reasoning === true,
      providerDisabled: disabled.has(entry.providerID),
    })
  }
  return meta
}

export function findUnmatchedScorecardKeys(
  cfg: ConfigLike,
  options: RouterOptions,
  catalog?: CatalogLike,
): string[] {
  const known = new Set(collectCandidates(cfg, options, catalog).map((c) => c.key))
  return Object.keys(options.models).filter((key) => !known.has(key))
}

export function collectCandidates(
  cfg: ConfigLike,
  options: RouterOptions,
  catalog?: CatalogLike,
): Candidate[] {
  const disabled = new Set(cfg.disabled_providers ?? [])
  const hidden = new Set(options.excludeModels ?? [])

  return collectModels(cfg, options, catalog).map((entry) => ({
    key: entry.key,
    providerID: entry.providerID,
    modelID: entry.modelID,
    entry: options.models[entry.key],
    providerDisabled: disabled.has(entry.providerID),
    hidden: hidden.has(entry.key),
  }))
}

/**
 * Injected by the plugin config hook so "Model Router" is selectable in the
 * normal model picker. It is never a routing candidate and never reaches a
 * provider API: `chat.message` rewrites it to a concrete model.
 */
export const ROUTER_PROVIDER_ID = "model-router"
export const ROUTER_MODEL_ID = "auto"
export const ROUTER_MODEL_KEY = `${ROUTER_PROVIDER_ID}/${ROUTER_MODEL_ID}`
