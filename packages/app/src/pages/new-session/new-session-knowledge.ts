// Pure decision helper for the new-session knowledge empty state. The view
// lists each candidate folder's `.opencode/knowledge` dir through the file
// API; a missing or unreadable listing means no usable notes there. Only
// markdown files ground knowledge sessions, so other files don't clear it.
export function knowledgeNotesEmpty(lists: ReadonlyArray<readonly string[] | undefined>) {
  if (lists.length === 0) return false
  return lists.every((paths) => (paths ?? []).every((file) => !file.endsWith(".md")))
}

// A failed listing alone cannot tell "missing" from "unreadable". The view
// lists the parent instead: when that succeeds without the target directory,
// the knowledge folder provably does not exist yet, which means no notes.
export function directoryMissing(parentEntries: readonly string[], target: string) {
  const wanted = target.replaceAll("\\", "/")
  return !parentEntries.some((entry) => entry.replaceAll("\\", "/").replace(/\/+$/, "") === wanted)
}
