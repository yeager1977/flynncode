import { sameGroup } from "@flynncode/session-ui/message-part"
import { TimelineRow, type SummaryDiff } from "./timeline-row"

type ContextRow = Extract<TimelineRow.TimelineRow, { _tag: "AssistantPart" }>
type PriorContext = { index: number; row: ContextRow }

export function reuseTimelineRows(previous: TimelineRow.TimelineRow[] | undefined, rows: TimelineRow.TimelineRow[]) {
  if (!previous?.length) return rows
  const byKey = new Map(previous.map((row) => [TimelineRow.key(row), row] as const))
  const contextByPart = new Map<string, PriorContext>()
  previous.forEach((row, index) => {
    if (row._tag !== "AssistantPart" || row.group.type !== "context") return
    row.group.refs.forEach((ref) => contextByPart.set(`${row.userMessageID}:${ref.partID}`, { index, row }))
  })
  const reserved = new Map<string, number>()
  rows.forEach((row, index) => {
    if (row._tag !== "AssistantPart" || row.group.type !== "context") return
    const key = TimelineRow.key(row)
    if (byKey.has(key) && !reserved.has(key)) reserved.set(key, index)
  })
  const claimed = new Set<string>()
  const next = rows.map((input, index) => {
    const row = stabilizeContextKey(contextByPart, reserved, input, index, claimed)
    const existing = byKey.get(TimelineRow.key(row))
    if (!existing) return row
    return sameRow(existing, row) ? existing : row
  })
  if (previous.length === next.length && previous.every((row, index) => row === next[index])) return previous
  return next
}

function stabilizeContextKey(
  contextByPart: Map<string, PriorContext>,
  reserved: Map<string, number>,
  row: TimelineRow.TimelineRow,
  rowIndex: number,
  claimed: Set<string>,
) {
  if (row._tag !== "AssistantPart" || row.group.type !== "context") return row
  const existing = row.group.refs.reduce<PriorContext | undefined>((result, ref) => {
    const candidate = contextByPart.get(`${row.userMessageID}:${ref.partID}`)
    if (!candidate) return result
    const key = TimelineRow.key(candidate.row)
    if (claimed.has(key)) return result
    const owner = reserved.get(key)
    if (owner !== undefined && owner !== rowIndex) return result
    return !result || candidate.index < result.index ? candidate : result
  }, undefined)
  if (!existing) return row
  const key = TimelineRow.key(existing.row)
  claimed.add(key)
  if (row.group.key === existing.row.group.key) return row
  return new TimelineRow.AssistantPart({
    ...row,
    group: { ...row.group, key: existing.row.group.key },
  })
}

// Field-by-field per tag: rows are rebuilt for every projected change, and a structural deep compare
// of each one dominated streaming flushes. A field missing here keeps a stale row on screen.
function sameRow(a: TimelineRow.TimelineRow, b: TimelineRow.TimelineRow) {
  if (a === b) return true
  if (a.userMessageID !== b.userMessageID) return false
  switch (a._tag) {
    case "TurnGap":
    case "CommentStrip":
    case "Retry":
      return b._tag === a._tag
    case "UserMessage":
      return b._tag === "UserMessage" && a.anchor === b.anchor
    case "TurnDivider":
      return (
        b._tag === "TurnDivider" &&
        a.label === b.label &&
        a.hookEvent === b.hookEvent &&
        a.hookReason === b.hookReason &&
        a.scheduleKind === b.scheduleKind &&
        a.scheduleDetail === b.scheduleDetail
      )
    case "AssistantPart":
      return (
        b._tag === "AssistantPart" &&
        a.previousAssistantPart === b.previousAssistantPart &&
        a.verbose === b.verbose &&
        a.hideTrailingSuggestion === b.hideTrailingSuggestion &&
        sameGroup(a.group, b.group)
      )
    case "Thinking":
      return b._tag === "Thinking" && a.reasoningHeading === b.reasoningHeading
    case "DiffSummary":
      return (
        b._tag === "DiffSummary" &&
        a.diffs.length === b.diffs.length &&
        a.diffs.every((diff, index) => sameDiff(diff, b.diffs[index]!))
      )
    case "Error":
      return (
        b._tag === "Error" &&
        a.text === b.text &&
        a.usageLimit?.providerID === b.usageLimit?.providerID &&
        a.usageLimit?.modelID === b.usageLimit?.modelID &&
        a.usageLimit?.resetAt === b.usageLimit?.resetAt &&
        !a.usageLimit === !b.usageLimit
      )
    case "TaskSuggestion":
      return b._tag === "TaskSuggestion" && a.title === b.title && a.prompt === b.prompt && a.note === b.note
  }
}

function sameDiff(a: SummaryDiff, b: SummaryDiff) {
  return (
    a === b ||
    (a.file === b.file &&
      a.patch === b.patch &&
      a.additions === b.additions &&
      a.deletions === b.deletions &&
      a.status === b.status)
  )
}
