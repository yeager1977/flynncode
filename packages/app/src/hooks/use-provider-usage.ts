import { createQuery } from "@tanstack/solid-query"
import { createEffect, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import type { UsageMap } from "@/utils/provider-usage"

// `active` gates every request and the refresh timer: while it is false nothing is fetched or polled.
// The Usage page is active while it is mounted; the titlebar menu only while it is open.
export function useProviderUsage(active: Accessor<boolean> = () => true) {
  const serverSDK = useServerSDK()
  const query = createQuery(() => ({
    queryKey: [serverSDK().scope, null, "provider-usage"],
    queryFn: async ({ signal }) => {
      const result = await serverSDK().client.provider.usage(undefined, { signal })
      return (result.data ?? {}) as UsageMap
    },
    enabled: active(),
    // The server aggregates on a 60s cache, so refresh on the same clock instead of stacking provider requests.
    refetchInterval: active() ? 60_000 : false,
    // Opening the menu always refetches; the server cache keeps that cheap.
    staleTime: 0,
    retry: false,
  }))

  // Never read `query.data` in a memo, a JSX expression or any other render computation. While the query is
  // loading, that read goes through the query's internal resource and registers a permanent Suspense reader; every
  // later refetch then trips the nearest <Suspense>, which blanks the route and resets the scroll offset of the
  // session timeline. User effects do not register with Suspense, so the read happens here and components read this
  // mirror instead. The status flags returned below (`isError`, `isFetching`) are plain store reads and do not suspend.
  const [mirror, setMirror] = createStore<{ data: UsageMap | undefined }>({ data: undefined })
  createEffect(() => setMirror("data", reconcile(query.data)))

  return {
    data: () => mirror.data,
    failed: () => query.isError,
    fetching: () => query.isFetching,
    refetch: () => void query.refetch({ cancelRefetch: false }),
  }
}
