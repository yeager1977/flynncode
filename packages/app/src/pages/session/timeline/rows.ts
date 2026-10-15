import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { AssistantMessage, Part, SessionStatus, UserMessage } from "@flynncode/sdk/v2"
import { groupParts, renderable, type PartGroup } from "@flynncode/session-ui/message-part"
import { TimelineRow, type SummaryDiff } from "./timeline-row"
import { uniqueSummaryDiffs } from "./summary-diffs"
import { compareMessages } from "@/utils/session-message"
import { usageLimit } from "@flynncode/core/session/usage-limit"

export { TimelineRow, type SummaryDiff } from "./timeline-row"

export type TimelineViewMode = "normal" | "thinking" | "verbose"

// Task-chip envelope the model may emit (see the message tool guidance).
// Attributes are XML-style; quotes and ampersands inside values use entities.
export namespace TaskSuggestion {
  export type Suggestion = {
    title: string
    prompt: string
    note?: string
  }

  const ENTITY: Record<string, string> = {
    "&quot;": '"',
    "&#34;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
  }

  const decode = (value: string) =>
    value
      .replace(/\\([<>&"])/g, "$1")
      .replace(/\\n/g, "\n")
      .replace(/&(?:quot|#34|apos|#39|lt|gt|amp);/g, (key) => ENTITY[key] ?? key)

  const attributes = (source: string) => {
    const result: Record<string, string> = {}
    for (const match of source.matchAll(/([a-zA-Z_][\w-]*)="((?:[^"\\]|\\.)*)"/g)) {
      const name = match[1]
      if (!name) continue
      result[name] = decode(match[2] ?? "")
    }
    return result
  }

  export const parse = (text: string): Suggestion | undefined => {
    const match = text.match(/<task-suggestion\b([^>]*)>([\s\S]*?)<\/task-suggestion>/)
    if (!match) return
    const attrs = attributes(match[1] ?? "")
    const title = (attrs.title ?? "").trim()
    const prompt = (attrs.prompt ?? "").trim()
    if (!title || !prompt) return
    const note = (match[2] ?? "").trim()
    return note ? { title, prompt, note } : { title, prompt }
  }

  // Removes a trailing suggestion envelope (plus preceding trailing
  // whitespace) from assistant body text. The chip row is the envelope's
  // only visible representation once the turn settles, so the body keeps
  // just the prose. A non-trailing envelope is left alone.
  export const strip = (text: string): string => {
    const pattern = /<task-suggestion\b[^>]*>[\s\S]*?<\/task-suggestion>/g
    let last: RegExpExecArray | undefined
    for (const match of text.matchAll(pattern)) last = match
    if (!last) return text
    if (text.slice(last.index + last[0].length).trim() !== "") return text
    return text.slice(0, last.index).replace(/\s*$/, "")
  }

  // Suggestions live at the very end of an assistant reply (the guidance says
  // standalone trailing line), so only the last text part is scanned.
  export const fromParts = (parts: readonly Part[]): Suggestion | undefined => {
    for (const part of parts.toReversed()) {
      if (part.type !== "text" || !part.text?.trim()) continue
      return parse(part.text)
    }
    return
  }
}

export type TimelineRowMap = {
  TurnGap: { userMessageID: string }
  CommentStrip: {
    userMessageID: string
  }
  UserMessage: {
    userMessageID: string
    anchor: boolean
  }
  TurnDivider: {
    userMessageID: string
    label: "compaction" | "interrupted" | "background"
  }
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    verbose?: boolean
    // Set when this part's text ends with the turn's task-suggestion envelope;
    // the renderer strips the envelope so the chip is its only representation.
    hideTrailingSuggestion?: boolean
  }
  Thinking: { userMessageID: string; reasoningHeading?: string }
  Retry: { userMessageID: string }
  DiffSummary: { userMessageID: string; diffs: SummaryDiff[] }
  Error: { userMessageID: string; text: string; usageLimit?: TimelineRow.UsageLimit }
  TaskSuggestion: { userMessageID: string; title: string; prompt: string; note?: string }
}

export namespace Timeline {
  export function constructSessionMessageRows(
    messages: SessionMessageInfo[],
    getMessage: (messageID: string) => UserMessage | AssistantMessage | undefined,
    getMessageParts: (messageID: string) => Part[],
    showReasoning: boolean,
    status: SessionStatus["type"],
    inlineComments: boolean,
    projectedUserMessages: UserMessage[],
    viewMode: TimelineViewMode = "normal",
  ) {
    const turns: { user: UserMessage; assistants: AssistantMessage[] }[] = []
    const turnByUserID = new Map<string, (typeof turns)[number]>()
    messages.forEach((message) => {
      const projected = getMessage(message.id)
      if (message.type === "shell" && projected?.role === "user") {
        const assistant = getMessage(`${message.id}:assistant`)
        const turn = { user: projected, assistants: assistant?.role === "assistant" ? [assistant] : [] }
        turns.push(turn)
        turnByUserID.set(projected.id, turn)
        return
      }
      if (projected?.role === "user") {
        if (turnByUserID.has(projected.id)) return
        const turn = { user: projected, assistants: [] }
        turns.push(turn)
        turnByUserID.set(projected.id, turn)
        return
      }
      if (projected?.role !== "assistant") return
      const existing = turnByUserID.get(projected.parentID)
      if (existing) {
        existing.assistants.push(projected)
        return
      }
      const user = getMessage(projected.parentID)
      if (user?.role !== "user") return
      const turn = { user, assistants: [projected] }
      turns.push(turn)
      turnByUserID.set(user.id, turn)
    })
    projectedUserMessages.forEach((user) => {
      if (turnByUserID.has(user.id)) return
      const turn = { user, assistants: [] }
      const index = turns.findIndex((item) => compareMessages(user, item.user) < 0)
      if (index < 0) turns.push(turn)
      if (index >= 0) turns.splice(index, 0, turn)
      turnByUserID.set(user.id, turn)
    })
    const activeMessageID = turns.at(-1)?.user.id
    return {
      activeMessageID,
      rows: turns.flatMap((turn, index) =>
        constructMessageRows(
          turn.user,
          getMessageParts,
          turn.assistants,
          index,
          showReasoning,
          status,
          turn.user.id === activeMessageID,
          inlineComments,
          viewMode,
        ),
      ),
    }
  }

  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: AssistantMessage[],
    index: number,
    showReasoning: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
    // v2 renders comments inside the user message attachments row instead of a strip row
    inlineComments: boolean,
    // View mode: normal collapses everything (current default), thinking also
    // shows reasoning blocks, verbose also keeps every tool part expanded-listed.
    viewMode: TimelineViewMode = "normal",
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const background =
      userParts.some((p) => p.type === "text") &&
      userParts.every((p) => p.type !== "text" || p.synthetic) &&
      userParts.every((p) => p.type !== "file" && p.type !== "agent")
    const compaction = userParts.some((p) => p.type === "compaction")
    const interruptedMessageIndex = assistantMessages.findIndex((m) => m.error?.name === "MessageAbortedError")
    const interrupted = interruptedMessageIndex !== -1
    const latestAssistant = assistantMessages.at(-1)
    const latestError = latestAssistant?.error
    const error = latestError?.name === "MessageAbortedError" ? undefined : latestError

    const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) => renderable(part, showReasoning || viewMode !== "normal"))
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    const assistantItems =
      interrupted && !compaction
        ? [
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
            { type: "interrupted" as const },
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex > interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
          ]
        : groupParts(assistantPartRefs).map((group) => ({ type: "part" as const, group }))
    if (previousUserMessage) rows.push(new TimelineRow.TurnGap({ userMessageID: userMessage.id }))

    if (comments.length > 0 && !inlineComments)
      rows.push(
        new TimelineRow.CommentStrip({
          userMessageID: userMessage.id,
        }),
      )

    if (background) {
      rows.push(
        new TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "background",
        }),
      )
    } else {
      rows.push(
        new TimelineRow.UserMessage({
          userMessageID: userMessage.id,
          anchor: inlineComments || comments.length === 0,
        }),
      )
    }

    if (compaction) {
      rows.push(
        new TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "compaction",
        }),
      )
    }

    // Task chip: the model-suggested follow-up renders after the turn's parts
    // once the turn has settled (not while it is still streaming).
    const settled = !(isActive && status === "busy")
    const found = settled
      ? MessageComment.taskSuggestionFromMessages(assistantMessages, getMessageParts)
      : undefined

    let assistantGroupIndex = 0
    assistantItems.forEach((item) => {
      if (item.type === "interrupted") {
        rows.push(
          new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "interrupted",
          }),
        )
        return
      }

      rows.push(
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
          verbose: viewMode === "verbose",
          hideTrailingSuggestion:
            found &&
            item.group.type === "part" &&
            item.group.ref.messageID === found.messageID &&
            item.group.ref.partID === found.partID
              ? true
              : undefined,
        }),
      )
      assistantGroupIndex += 1
    })

    // Chip row for the suggestion computed above.
    const suggestion = found?.suggestion
    if (suggestion) {
      rows.push(
        new TimelineRow.TaskSuggestion({
          userMessageID: userMessage.id,
          title: suggestion.title,
          prompt: suggestion.prompt,
          note: suggestion.note,
        }),
      )
    }

    if (
      isActive &&
      status === "busy" &&
      !error &&
      (viewMode === "normal" ? (showReasoning ? assistantPartRefs.length === 0 : true) : assistantPartRefs.length === 0)
    ) {
      const heading = assistantMessages
        .flatMap((message) => getMessageParts(message.id))
        .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
        .find((value): value is string => !!value)

      rows.push(
        new TimelineRow.Thinking({
          userMessageID: userMessage.id,
          reasoningHeading: viewMode === "normal" ? heading : undefined,
        }),
      )
    }

    if (isActive && status === "retry") rows.push(new TimelineRow.Retry({ userMessageID: userMessage.id }))

    const diffs = uniqueSummaryDiffs(userMessage.summary?.diffs)
    if (diffs.length > 0 && (status === "idle" || !isActive)) {
      rows.push(
        new TimelineRow.DiffSummary({
          userMessageID: userMessage.id,
          diffs,
        }),
      )
    }

    // Anchor relative retry-after headers to when the turn failed, not to render time.
    const limit = latestAssistant && usageLimit(error, latestAssistant.time.completed ?? latestAssistant.time.created)
    if (latestAssistant && limit) {
      rows.push(
        new TimelineRow.Error({
          userMessageID: userMessage.id,
          text: unwrapErrorMessage(limit.message),
          usageLimit: {
            providerID: latestAssistant.providerID,
            modelID: latestAssistant.modelID,
            ...(limit.resetAt === undefined ? {} : { resetAt: limit.resetAt }),
          },
        }),
      )
    }

    if (error && !limit) {
      const data = error.data?.message
      rows.push(
        new TimelineRow.Error({
          userMessageID: userMessage.id,
          text: unwrapErrorMessage(
            typeof data === "string" ? data : data === undefined || data === null ? "" : String(data),
          ),
        }),
      )
    }

    return rows
  }

  function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return value
    }
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    const parse = (value: string) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        return undefined
      }
    }

    const read = (value: string) => {
      const first = parse(value)
      if (typeof first !== "string") return first
      return parse(first.trim())
    }

    let json = read(text)

    if (json === undefined) {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
    }

    if (!record(json)) return message

    const err = record(json.error) ? json.error : undefined
    if (err) {
      const type = typeof err.type === "string" ? err.type : undefined
      const msg = typeof err.message === "string" ? err.message : undefined
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      const code = typeof err.code === "string" ? err.code : undefined
      if (code) return code
    }

    const msg = typeof json.message === "string" ? json.message : undefined
    if (msg) return msg

    const reason = typeof json.error === "string" ? json.error : undefined
    if (reason) return reason

    return message
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
}

export namespace MessageComment {
  export type MessageComment = {
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return
    return {
      path: next.path,
      comment: next.comment,
      selection: next.selection
        ? {
            startLine: next.selection.startLine,
            endLine: next.selection.endLine,
          }
        : undefined,
    }
  }

  // First task-suggestion envelope across a turn's assistant messages, in
  // chronological order; later messages win only when earlier ones lack one.
  // Returns the source part ref alongside the suggestion so the row builder
  // can mark the exact row for envelope stripping.
  export const taskSuggestionFromMessages = (
    assistantMessages: readonly AssistantMessage[],
    getMessageParts: (messageID: string) => Part[],
  ): { suggestion: TaskSuggestion.Suggestion; messageID: string; partID: string } | undefined => {
    for (const message of [...assistantMessages].reverse()) {
      const parts = getMessageParts(message.id)
      const text = parts.toReversed().find((part) => part.type === "text" && !!part.text?.trim())
      if (!text || text.type !== "text") continue
      const suggestion = TaskSuggestion.parse(text.text ?? "")
      if (suggestion) return { suggestion, messageID: message.id, partID: text.id }
    }
    return
  }
}
