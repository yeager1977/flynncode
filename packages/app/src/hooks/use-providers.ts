import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { createEffect, createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { selectPopularProviders, selectProviderCatalog } from "./provider-catalog"

export { popularProviders } from "./provider-catalog"

export function useProviders(directory: Accessor<string | undefined>) {
  const serverSync = useServerSync()
  const params = useParams()
  const dir = () => (directory ? directory() : decode64(params.dir))
  const providers = () => {
    const value = dir()
    const projectStore = value ? serverSync().child(value)[0] : undefined
    if (value)
      return selectProviderCatalog({
        explicit: true,
        directory: value,
        catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      })
    return selectProviderCatalog({
      explicit: false,
      directory: value,
      catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      global: serverSync().data.provider,
    })
  }

  return {
    all: () => providers().all,
    // Resolves a provider missing from `all`, such as one a past message used before it was disconnected.
    lookup: (providerID: string) => serverSync().lookupProvider(providerID),
    default: () => providers().default,
    defaultModel: () => providers().defaultModel,
    connected: () => {
      const connected = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      const paid = [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connected.has(id) &&
            (id !== "opencode" || Object.values(providers().all.get(id)?.models ?? {}).some((m) => m.cost?.input)),
        ),
      ]
      return paid
    },
  }
}

// The full catalog, including providers that are not connected. Only the dialogs that connect providers or
// manage models read it, so it loads on demand; until it arrives they see the connected providers.
export function useProviderCatalog() {
  const serverSync = useServerSync()
  const query = useQuery(() => serverSync().queryOptions.providerCatalog())
  const all = () => query.data?.all ?? serverSync().data.provider.all
  return {
    all,
    popular: () => selectPopularProviders(all()),
    loading: () => query.isLoading,
    failed: () => query.isError,
    retry: () => void query.refetch(),
  }
}
