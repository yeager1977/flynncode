export type WorktreeRetentionEntry = {
  directory: string
  updated: number
  open?: boolean
  running?: boolean
  disposable?: boolean
  lastUsedAt?: number
}

export function worktreesToRemove(entries: readonly WorktreeRetentionEntry[], limit = 15) {
  const recency = (entry: WorktreeRetentionEntry) => entry.lastUsedAt ?? entry.updated
  const ordered = [...entries].sort((a, b) => recency(b) - recency(a))
  const kept = new Set<string>()
  const remove: string[] = []
  for (const entry of ordered) {
    if (entry.open || entry.running || kept.size < limit) {
      kept.add(entry.directory)
      continue
    }
    remove.push(entry.directory)
  }
  return remove
}
