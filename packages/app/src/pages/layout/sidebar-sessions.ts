import { createMemo } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { Session } from "@flynncode/sdk/v2/client"
import type { HomeSessionEvents } from "@/context/global-sync/home-session-index"
import { loadHomeSessionIndex, retainHomeSessions } from "@/context/global-sync/home-session-index"
import { useLayout, type LocalProject } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import { compareSessionTime } from "./helpers"

// Enough history per directory for "Show more" without listing everything.
const SESSIONS_PER_DIRECTORY = 50

export type SidebarGroup = { project: LocalProject; sessions: Session[] }

// The sidebar lists every open project's root sessions from the same live
// index Home uses (one request, kept current by session events), instead of
// loading each project's directory store.
export function createSidebarSessions() {
  const layout = useLayout()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const cache = () => serverSync().homeSessions
  const events = useQuery(
    () => ({
      queryKey: cache().eventsKey,
      queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
      initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
      enabled: false,
    }),
    () => serverSync().queryClient,
  )
  // Read the index from server-sync's client: session events and archives update
  // that cache, and the app's route-level QueryProvider is a different client.
  const index = useQuery(
    () => ({
      queryKey: cache().indexKey,
      queryFn: async ({ signal }) => {
        const sequence = cache().eventSequence()
        const result = await loadHomeSessionIndex(
          (input, options) => serverSDK().client.v2.session.list(input, options),
          sequence,
          signal,
        )
        cache().complete(sequence)
        return result
      },
      retry: false,
      staleTime: 30_000,
      refetchOnMount: true,
      refetchOnReconnect: true,
    }),
    () => serverSync().queryClient,
  )
  const sessions = createMemo(() =>
    retainHomeSessions(cache().sessions(index.data, events.data), SESSIONS_PER_DIRECTORY, Date.now()),
  )
  // Keep unchanged session objects across refreshes so the sidebar rows (and
  // an in-progress rename or an open context menu) survive a re-fetch. The
  // order still follows the fresh time.updated.
  let previous: Session[] = []
  const stable = createMemo(() => {
    const next = sessions()
    previous = stableSessions(previous, next)
    return previous
  })
  const groups = createMemo(() => groupByProject(layout.projects.list(), stable(), sessions()))
  return { groups, loading: () => index.isLoading }
}

export function groupByProject(
  projects: readonly LocalProject[],
  sessions: readonly Session[],
  order?: readonly Session[],
): SidebarGroup[] {
  // Sort by the fresh sessions when given, so a session that just received a
  // message moves up even though its rendered row is unchanged.
  const byID = new Map((order ?? sessions).map((session) => [session.id, session]))
  const sorted = [...sessions].toSorted((a, b) => compareSessionTime(byID.get(a.id) ?? a, byID.get(b.id) ?? b))
  return projects.map((project) => {
    const directories = new Set([project.worktree, ...(project.sandboxes ?? [])].map(pathKey))
    return {
      project,
      sessions: sorted.filter((session) => directories.has(pathKey(session.directory))),
    }
  })
}

// The sidebar list re-fetches on mount, on reconnect and every 30s, and each
// fetch returns fresh session objects. Solid's <For> reuses a row only when
// the item is the same reference, so a refresh tears down every row — which
// drops an in-progress rename and closes an open context menu. Reuse the
// previous object when the row would render the same thing. The sort order
// still follows the fresh time.updated.
export function stableSessions(previous: readonly Session[], next: readonly Session[]) {
  const byID = new Map(previous.map((session) => [session.id, session]))
  return next.map((session) => {
    const prior = byID.get(session.id)
    if (!prior) return session
    if (prior.title !== session.title) return session
    if (prior.directory !== session.directory) return session
    if (prior.parentID !== session.parentID) return session
    if (prior.agent !== session.agent) return session
    if (prior.time?.archived !== session.time?.archived) return session
    return prior
  })
}
