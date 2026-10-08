// Pure decision helper for the new-session knowledge empty state. The view
// lists each candidate folder's `.opencode/knowledge` dir through the file
// API; a missing or unreadable listing means no usable notes there. Only
// markdown files ground knowledge sessions, so other files don't clear it.
export function knowledgeNotesEmpty(lists: ReadonlyArray<readonly string[] | undefined>) {
  if (lists.length === 0) return false
  return lists.every((paths) => (paths ?? []).every((file) => !file.endsWith(".md")))
}
