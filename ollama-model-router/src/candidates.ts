import type { ModelMeta, RouterOptions } from "./types"
import type { Candidate } from "./rank"

type ProviderLike = {
  models?: Record<string, unknown>
}

type ConfigLike = {
  provider?: Record<string, ProviderLike | undefined>
  disabled_providers?: string[]
}

type ModelEntryLike = {
  name?: unknown
  tool_call?: unknown
  reasoning?: unknown
  limit?: { context?: unknown }
}

export function collectMeta(cfg: ConfigLike, options: RouterOptions): Map<string, ModelMeta> {
  const disabled = new Set(cfg.disabled_providers ?? [])
  const selected = (providerID: string) => {
    if (options.providers.length > 0) return options.providers.includes(providerID)
    return providerID.startsWith("ollama")
  }

  const meta = new Map<string, ModelMeta>()
  for (const [providerID, provider] of Object.entries(cfg.provider ?? {})) {
    if (!provider || !provider.models) continue
    if (!selected(providerID)) continue
    for (const [modelID, raw] of Object.entries(provider.models)) {
      const entry = (raw ?? {}) as ModelEntryLike
      const key = `${providerID}/${modelID}`
      meta.set(key, {
        providerID,
        modelID,
        name: typeof entry.name === "string" ? entry.name : undefined,
        context: typeof entry.limit?.context === "number" ? entry.limit.context : undefined,
        toolCall: entry.tool_call === true,
        reasoning: entry.reasoning === true,
        providerDisabled: disabled.has(providerID),
      })
    }
  }
  return meta
}

export function collectCandidates(cfg: ConfigLike, options: RouterOptions): Candidate[] {
  const disabled = new Set(cfg.disabled_providers ?? [])
  const selected = (providerID: string) => {
    if (options.providers.length > 0) return options.providers.includes(providerID)
    return providerID.startsWith("ollama")
  }

  const out: Candidate[] = []
  for (const [providerID, provider] of Object.entries(cfg.provider ?? {})) {
    if (!provider || !provider.models) continue
    if (!selected(providerID)) continue
    for (const modelID of Object.keys(provider.models)) {
      const key = `${providerID}/${modelID}`
      out.push({
        key,
        providerID,
        modelID,
        entry: options.models[key],
        providerDisabled: disabled.has(providerID),
      })
    }
  }
  return out
}
