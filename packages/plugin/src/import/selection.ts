import type { SourceCandidate } from "./discover.js"

export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export type SelectionOption = {
  readonly title: string
  readonly description: string
  readonly value: SourceCandidate
  readonly disabled: boolean
}

export function buildOptions(
  candidates: ReadonlyArray<SourceCandidate>,
  imported: ReadonlySet<string>,
): ReadonlyArray<SelectionOption> {
  return candidates.map((item) => ({
    title: item.title,
    description: `${item.messageCount} messages · ${item.cwd}`,
    value: item,
    disabled: imported.has(item.sourceSessionID),
  }))
}