// Presentation-only normalization of OMO orchestration todo text. The full
// content is preserved verbatim by todoDetail; todoSummary only derives the
// concise action line for compact rendering.

const MAX_SUMMARY_LENGTH = 120

// Matches `<path>: <action> - expect <result>`; the token before the colon must be path-like (contains `/` or `.`)
const PATH_ACTION_PATTERN = /^(\S*[/.]\S*):\s+(.+?)\s+-\s+expect\s+.+$/

export function todoSummary(content: string): string {
  const stripped = content.replace(/^\[[^\]]*\]\s*/, "")
  const match = stripped.match(PATH_ACTION_PATTERN)
  if (!match) return stripped
  const action = match[2]
  if (action.length <= MAX_SUMMARY_LENGTH) return action
  const cut = action.lastIndexOf(" ", MAX_SUMMARY_LENGTH)
  return action.slice(0, cut) + "\u2026"
}

export function todoDetail(content: string): string {
  return content
}

export function splitTodoContent(content: string): { summary: string; detail: string } {
  return { summary: todoSummary(content), detail: todoDetail(content) }
}
