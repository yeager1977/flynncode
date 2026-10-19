import { createQuery } from "@tanstack/solid-query"
import { useServerSDK } from "@/context/server-sdk"
import type { UsageMap } from "@/utils/provider-usage"

export function useProviderUsage() {
  const serverSDK = useServerSDK()
  return createQuery(() => ({
    queryKey: [serverSDK().scope, null, "provider-usage"],
    queryFn: async ({ signal }) => {
      const result = await serverSDK().client.provider.usage(undefined, { signal })
      return (result.data ?? {}) as UsageMap
    },
    // Minute-level freshness: the server aggregates on a 60s cache, so the two
    // clocks line up instead of stacking provider requests.
    refetchInterval: 60_000,
    staleTime: 60_000,
    retry: false,
  }))
}
