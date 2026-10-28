import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@flynncode/sdk/v2"
import { createMemo, mapArray, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow, type TimelineViewMode } from "./rows"

export { reuseTimelineRows } from "./row-reconciliation"

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  sessionMessages: Accessor<SessionMessageInfo[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
  inlineComments: Accessor<boolean>
  viewMode?: Accessor<TimelineViewMode | undefined>
}) {
  const messageByID = createMemo(() => new Map(input.messages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    input.messages().forEach((message) => {
      if (message.role !== "assistant") return
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(message.parentID, [message])
    })
    return result
  })
  // Rows are built per turn, so a streamed change re-projects only the turn it touches; turns are keyed
  // by their user message ID, and every other turn keeps its row array (and row objects).
  const turns = createMemo(() =>
    Timeline.constructTurns(
      input.sessionMessages(),
      (messageID) => messageByID().get(messageID) as UserMessage | AssistantMessage | undefined,
      input.userMessages(),
    ),
  )
  const turnByID = createMemo(() => new Map(turns().map((turn) => [turn.user.id, turn] as const)))
  const turnIDs = createMemo(() => turns().map((turn) => turn.user.id), [], { equals: sameItems })
  const activeMessageID = createMemo(() => turnIDs().at(-1))
  const turnRows = mapArray(turnIDs, (userMessageID, index) => {
    const turn = createMemo(() => turnByID().get(userMessageID), undefined, { equals: sameTurn })
    const first = createMemo(() => index() === 0)
    const active = createMemo(() => activeMessageID() === userMessageID)
    return createMemo((previous: TimelineRow.TimelineRow[]) => {
      const current = turn()
      if (!current) return previous
      const isActive = active()
      return reuseTimelineRows(
        previous,
        Timeline.constructMessageRows(
          current.user,
          input.parts,
          current.assistants,
          first() ? 0 : 1,
          input.showReasoningSummaries(),
          // Status only shapes the active turn's rows; settled turns must not rebuild when it changes.
          isActive ? input.status().type : "idle",
          isActive,
          input.inlineComments(),
          input.viewMode?.() ?? "normal",
        ),
      )
    }, [])
  })
  const rows = createMemo((previous: TimelineRow.TimelineRow[]) => {
    const next = turnRows().flatMap((rows) => rows())
    return sameItems(previous, next) ? previous : next
  }, [])
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (!("userMessageID" in row) || result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const messageLastRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if ("userMessageID" in row) result.set(row.userMessageID, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    rows().forEach((row) => {
      if (row._tag === "AssistantPart") result.set(row.userMessageID, row.group.key)
    })
    return result
  })

  return {
    activeMessageID,
    assistantMessagesByParent,
    lastAssistantGroupKey,
    messageByID,
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}

function sameItems<T>(a: readonly T[], b: readonly T[]) {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function sameTurn(a: Timeline.Turn | undefined, b: Timeline.Turn | undefined) {
  if (!a || !b) return a === b
  return a.user === b.user && sameItems(a.assistants, b.assistants)
}
