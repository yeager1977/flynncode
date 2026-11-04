import type { NormalizedProviderListResponse } from "@flynncode/session-ui/context"
import { createEffect, untrack } from "solid-js"
import { createStore } from "solid-js/store"

// Messages can name providers that are no longer connected, which the slim connected list leaves out. The first
// lookup of one turns the full catalog query on (it loads once and is revalidated by ETag), so model names and
// context limits still resolve; nothing loads while every lookup hits the connected list. The catalog is several
// megabytes, so it loads in idle time, after the session that asked for it has rendered.
export function createProviderLookup(load: (enabled: () => boolean) => { data?: NormalizedProviderListResponse }) {
  const [state, setState] = createStore({ wanted: false, catalog: undefined as NormalizedProviderListResponse | undefined })
  const query = load(() => state.wanted)
  const scheduled = { value: false }

  // Never read `query.data` in a memo or any other render computation. Lookups run inside memos on the session
  // route, and a read there goes through the query's internal resource and registers with the route's <Suspense>:
  // when the catalog loads, the boundary blanks the whole route, the session timeline is detached and its scroll
  // offset resets to the top. User effects do not register, so the read happens here and lookups read the mirror.
  createEffect(() => setState("catalog", query.data))

  return (providerID: string) => {
    if (!scheduled.value && !untrack(() => state.wanted)) {
      scheduled.value = true
      if (typeof requestIdleCallback === "function")
        requestIdleCallback(() => setState("wanted", true), { timeout: 3_000 })
      else setTimeout(() => setState("wanted", true), 0)
    }
    return state.catalog?.all.get(providerID)
  }
}
