export type WorktreeRetentionEntry = {
  directory: string
  updated: number
  open?: boolean
  running?: boolean
}

export function worktreesToRemove(entries: readonly WorktreeRetentionEntry[], limit = 15) {
  const ordered = [...entries].sort((a, b) => b.updated - a.updated)
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
