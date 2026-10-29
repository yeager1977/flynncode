import type { Config } from "@flynncode/sdk/v2/client"

const providerConfigKeys = ["provider", "enabled_providers", "disabled_providers"] as const

// Whether a directory's config changes its provider list. A directory's config starts as the global one and is
// replaced by its own merged config once loaded, so only a project that sets these keys differs.
export function hasOwnProviderConfig(directory: Config, global: Config) {
  return providerConfigKeys.some((key) => JSON.stringify(directory[key]) !== JSON.stringify(global[key]))
}
