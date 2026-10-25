import { createQuery, useQueryClient } from "@tanstack/solid-query"
import type { WorktreeCleanupReport, WorktreeCleanupReviewItem } from "@flynncode/sdk/v2/client"
import { useServerSDK } from "@/context/server-sdk"

const empty: WorktreeCleanupReport = { items: [], cleaned: [], scanning: false }

export function useWorktreeCleanup() {
  const serverSDK = useServerSDK()
  const queryClient = useQueryClient()
  const key = () => [serverSDK().scope, null, "worktree-cleanup"]

  const query = createQuery(() => ({
    queryKey: key(),
    queryFn: async ({ signal }) => {
      const result = await serverSDK().client.worktreeCleanup.report({ signal })
      return result.data ?? empty
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  }))

  // Scanning blocks until the walk finishes, so the response is the fresh report.
  const scan = async () => {
    const result = await serverSDK().client.worktreeCleanup.scan()
    queryClient.setQueryData(key(), result.data ?? empty)
  }

  const remove = async (paths: string[]) => {
    const result = await serverSDK().client.worktreeCleanup.remove({ paths })
    await queryClient.invalidateQueries({ queryKey: key() })
    return result.data?.results ?? []
  }

  return { query, scan, remove }
}

export function groupByProject(items: WorktreeCleanupReviewItem[]) {
  const groups = Map.groupBy(items, (item) => item.project)
  return [...groups]
    .map(([project, entries]) => ({
      project,
      items: entries.toSorted((a, b) => b.bytes - a.bytes),
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    }))
    .toSorted((a, b) => b.bytes - a.bytes)
}

const units = ["B", "KB", "MB", "GB", "TB"]

// A capped size stopped counting at the walk limit, so it is a lower bound.
export function formatBytes(bytes: number, capped: boolean) {
  const exponent = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024))))
  const value = bytes / 1024 ** exponent
  const text = `${exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
  return capped ? `≥ ${text}` : text
}
