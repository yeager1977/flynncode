import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"

const emptyProviderCatalog: NormalizedProviderListResponse = { all: new Map(), connected: [], default: {} }

type DirectoryCatalog = {
  ready: boolean
  providers: NormalizedProviderListResponse
}

type ProviderCatalogInput =
  | {
      explicit: true
      directory?: string
      catalog?: DirectoryCatalog
    }
  | {
      explicit: false
      directory?: string
      catalog?: DirectoryCatalog
      global: NormalizedProviderListResponse
    }

export function selectProviderCatalog(input: ProviderCatalogInput) {
  if (input.directory && input.catalog?.ready) return input.catalog.providers
  if (input.explicit) return emptyProviderCatalog
  return input.global
}

export function resolveDefaultModel(
  current: NormalizedProviderListResponse["defaultModel"],
  legacy: string | undefined,
) {
  if (current !== undefined) return current ?? undefined
  if (!legacy) return undefined
  const [providerID, modelID] = legacy.split("/")
  return { providerID, modelID }
}

export async function completeProviderConnection(input: {
  providerID: string
  disabledProviders?: string[]
  updateConfig: (config: { disabled_providers: string[] }) => Promise<unknown>
  refreshProviders: () => Promise<unknown>
}) {
  try {
    const disabled = input.disabledProviders ?? []
    if (disabled.includes(input.providerID)) {
      await input.updateConfig({ disabled_providers: disabled.filter((id) => id !== input.providerID) })
    }
    await input.refreshProviders()
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, error }
  }
}
