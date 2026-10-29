import type { NormalizedProviderListResponse } from "@flynncode/session-ui/context"
import { createSignal, untrack } from "solid-js"

// Messages can name providers that are no longer connected, which the slim connected list leaves out. The first
// lookup of one turns the full catalog query on (it loads once and is revalidated by ETag), so model names and
// context limits still resolve; nothing loads while every lookup hits the connected list.
export function createProviderLookup(load: (enabled: () => boolean) => { data?: NormalizedProviderListResponse }) {
  const [wanted, setWanted] = createSignal(false)
  const catalog = load(wanted)
  return (providerID: string) => {
    if (!untrack(wanted)) queueMicrotask(() => setWanted(true))
    return catalog.data?.all.get(providerID)
  }
}
