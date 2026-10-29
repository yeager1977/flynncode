import type { Config } from "@flynncode/sdk/v2/client"

const providerConfigKeys = ["provider", "enabled_providers", "disabled_providers"] as const

// Whether a directory's config changes its provider list. A directory's merged config only adds to the global
// one, so a key it lacks has not loaded yet rather than differing.
export function hasOwnProviderConfig(directory: Config, global: Config) {
  return providerConfigKeys.some(
    (key) => directory[key] !== undefined && JSON.stringify(directory[key]) !== JSON.stringify(global[key]),
  )
}
