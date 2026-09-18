export type ImportCandidate = {
  readonly path: string
  readonly sourceSessionID: string
  readonly title: string
  readonly cwd: string
  readonly time: number
  readonly messageCount: number
  readonly imported: boolean
}

export type SelectionOption = {
  readonly label: string
  readonly disabled: boolean
  readonly value: ImportCandidate
}

export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function buildOptions(
  candidates: ReadonlyArray<ImportCandidate>,
  query: string,
): ReadonlyArray<SelectionOption> {
  const needle = query.trim().toLowerCase()
  return candidates
    .filter((item) => {
      if (!needle) return true
      return (
        item.title.toLowerCase().includes(needle) ||
        item.sourceSessionID.toLowerCase().includes(needle) ||
        item.cwd.toLowerCase().includes(needle)
      )
    })
    .map((item) => ({
      label: `${item.title} · ${item.messageCount}`,
      disabled: item.imported,
      value: item,
    }))
}

export function tally(results: ReadonlyArray<boolean>): { imported: number; failed: number } {
  return results.reduce(
    (acc, ok) => (ok ? { ...acc, imported: acc.imported + 1 } : { ...acc, failed: acc.failed + 1 }),
    { imported: 0, failed: 0 },
  )
}