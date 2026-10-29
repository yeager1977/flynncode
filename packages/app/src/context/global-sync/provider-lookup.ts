import type { NormalizedProviderListResponse } from "@flynncode/session-ui/context"
import { createSignal, untrack } from "solid-js"

// Messages can name providers that are no longer connected, which the slim connected list leaves out. The first
// lookup of one turns the full catalog query on (it loads once and is revalidated by ETag), so model names and
// context limits still resolve; nothing loads while every lookup hits the connected list. The catalog is several
// megabytes, so it loads in idle time, after the session that asked for it has rendered.
export function createProviderLookup(load: (enabled: () => boolean) => { data?: NormalizedProviderListResponse }) {
  const [wanted, setWanted] = createSignal(false)
  const catalog = load(wanted)
  const scheduled = { value: false }
  return (providerID: string) => {
    if (!scheduled.value && !untrack(wanted)) {
      scheduled.value = true
      if (typeof requestIdleCallback === "function") requestIdleCallback(() => setWanted(true), { timeout: 3_000 })
      else setTimeout(() => setWanted(true), 0)
    }
    return catalog.data?.all.get(providerID)
  }
}
