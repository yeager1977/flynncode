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
  const events = useQuery(() => ({
    queryKey: cache().eventsKey,
    queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
    initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
    enabled: false,
  }))
  const index = useQuery(() => ({
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
  }))
  const sessions = createMemo(() =>
    retainHomeSessions(cache().sessions(index.data, events.data), SESSIONS_PER_DIRECTORY, Date.now()),
  )
  const groups = createMemo(() => groupByProject(layout.projects.list(), sessions()))
  return { groups, loading: () => index.isLoading }
}

export function groupByProject(projects: readonly LocalProject[], sessions: readonly Session[]): SidebarGroup[] {
  return projects.map((project) => {
    const directories = new Set([project.worktree, ...(project.sandboxes ?? [])].map(pathKey))
    return {
      project,
      sessions: sessions.filter((session) => directories.has(pathKey(session.directory))).toSorted(compareSessionTime),
    }
  })
}
