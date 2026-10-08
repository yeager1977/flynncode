import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { SessionExportData } from "@/utils/session-export"
import type { StoredArtifact } from "@/pages/layout/sidebar-artifacts"

export type HistoryEntryKind = "run" | "change" | "approval" | "note"

export type HistoryEntry = {
  id: string
  time: number
  kind: HistoryEntryKind
  title: string
  detail: string
  sessionID: string
  file?: string
}

export type HistoryInput = {
  sessionID: string
  messages: SessionExportData["messages"]
  diffs: FileDiffInfo[]
  stored: StoredArtifact[]
}

function toolFile(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const record = input as Record<string, unknown>
  const file = record.file
  if (typeof file === "string" && file.length > 0) return file
  const path = record.path
  if (typeof path === "string" && path.length > 0) return path
  return undefined
}

function toolCommand(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  const record = input as Record<string, unknown>
  const command = record.command
  return typeof command === "string" ? command : JSON.stringify(input).slice(0, 200)
}

function messageTime(message: SessionExportData["messages"][number], fallback: number): number {
  const created = message.info.time.created
  return typeof created === "number" ? created : fallback
}

export function deriveSessionHistory(input: HistoryInput): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  const changed = new Set<string>()
  input.messages.forEach((message, index) => {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      const tool = part.tool
      const state = part.state
      if (state.status !== "completed" && state.status !== "error") continue
      const time = messageTime(message, index)
      if (tool === "bash") {
        const command = toolCommand(state.input)
        entries.push({
          id: `run-${message.info.id}-${part.callID}`,
          time,
          kind: "run",
          title: `Ran ${command.slice(0, 80)}`,
          detail: command,
          sessionID: input.sessionID,
        })
      }
      if (tool === "edit" || tool === "write" || tool === "apply_patch") {
        const file = toolFile(state.input) ?? "unknown file"
        changed.add(file)
        entries.push({
          id: `change-${message.info.id}-${part.callID}`,
          time,
          kind: "change",
          title: `Changed ${file}`,
          detail: `${tool} ${file}`,
          sessionID: input.sessionID,
          file,
        })
      }
      // Question-dock permission prompts surface here as tool input/state
      // metadata, so they count as approvals in the timeline.
      const stateMetadata = (state.metadata ?? {}) as Record<string, unknown>
      if (state.input.permissionAsked === true || stateMetadata.interrupted === true) {
        entries.push({
          id: `approval-${message.info.id}-${part.callID}`,
          time,
          kind: "approval",
          title: `Approval for ${tool}`,
          detail: stateMetadata.interrupted === true ? "Interrupted, needs decision" : "Asked and decided",
          sessionID: input.sessionID,
          file: toolFile(state.input),
        })
      }
    }
  })
  // Uncovered diffs describe current working-tree state, observed no earlier
  // than the latest message event, so they sort after the runs that produced them.
  const latest = input.messages.reduce((max, message, index) => {
    return Math.max(max, messageTime(message, index))
  }, 0)
  for (const diff of input.diffs) {
    if (changed.has(diff.file)) continue
    entries.push({
      id: `diff-${diff.file}`,
      time: latest,
      kind: "change",
      title: `Changed ${diff.file}`,
      detail: `+${diff.additions} -${diff.deletions}`,
      sessionID: input.sessionID,
      file: diff.file,
    })
  }
  for (const artifact of input.stored) {
    if (artifact.sessionID !== input.sessionID) continue
    if (artifact.type !== "note") continue
    entries.push({
      id: artifact.id,
      time: artifact.created,
      kind: "note",
      title: "Note",
      detail: artifact.text,
      sessionID: input.sessionID,
      file: artifact.file,
    })
  }
  entries.sort((a, b) => a.time - b.time)
  return entries
}

export function filterHistoryEntries(entries: readonly HistoryEntry[], query: string): HistoryEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...entries]
  return entries.filter((entry) => {
    return `${entry.title}\n${entry.detail}\n${entry.file ?? ""}`.toLowerCase().includes(needle)
  })
}
