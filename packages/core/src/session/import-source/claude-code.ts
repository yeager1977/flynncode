export * as ClaudeCode from "./claude-code"

import type { ImportedMessage, ParsedSession, SessionReader } from "./types.js"

type Record_ = Record<string, unknown>

const asRecord = (value: unknown): Record_ | undefined =>
  typeof value === "object" && value !== null ? (value as Record_) : undefined

const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined
  if (!Array.isArray(content)) return
  const blocks = content.flatMap((block) => {
    const item = asRecord(block)
    if (!item) return []
    if (item.type !== "text") return []
    const text = asString(item.text)
    return text ? [text] : []
  })
  if (!blocks.length) return
  return blocks.join("\n\n")
}

const TITLE_LIMIT = 80

// Claude Code automations invoke the model against a synthetic prompt rather
// than a human turn. Those runs land in the same store as real sessions and
// would otherwise flood the import list with meaningless stubs. A run is
// synthetic only when it has no human-origin user record AND no user text
// outside these templates, so a session with any genuine prompt is kept.
const SYNTHETIC_PROMPTS = ["Analyze this conversation and determine", "[structured-output-enforce]"]

const isSyntheticUserText = (text: string) => SYNTHETIC_PROMPTS.some((prefix) => text.startsWith(prefix))

// Slash-command bookkeeping Claude Code records as user turns: the command
// invocation wrapper and the local command's captured output.
const COMMAND_WRAPPER = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/

// Claude Code prepends context to the first human turn as one or more
// <system-reminder> blocks. Strip them from titles so the title reflects what
// the user actually asked, not the injected worktree/skill boilerplate.
const LEADING_REMINDERS = /^\s*(<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/

// Only user/assistant records with string content or text blocks can yield a
// message, so other lines (tool results, snapshots, summaries) skip
// JSON.parse. These lines dominate large stores.
const MESSAGE_TYPE = /"type"\s*:\s*"(user|assistant)"/
// A rename in Claude Code appends a custom-title record; the latest one is the session's name.
const CUSTOM_TITLE = /"type"\s*:\s*"custom-title"/
const HAS_TEXT = /"content"\s*:\s*"|"type"\s*:\s*"text"/

const titleText = (text: string) => {
  const withoutReminders = text.replace(LEADING_REMINDERS, "").trim()
  return withoutReminders || text.trim()
}

const hasHumanOrigin = (record: Record_) => {
  const origin = asRecord(record.origin)
  return origin?.kind === "human"
}

export function parseClaudeCode(input: { readonly path: string; readonly text: string }): ParsedSession {
  const reader = claudeCodeReader(input.path, { keepMessages: true })
  for (const raw of input.text.split("\n")) reader.push(raw)
  return reader.finish()
}

// Incremental parser: discovery streams lines through it with
// `keepMessages: false`, so only the summary (title, cwd, count, first time)
// is retained instead of every message of a multi-gigabyte store.
export function claudeCodeReader(path: string, options: { readonly keepMessages: boolean }): SessionReader {
  const state = {
    sessionID: "",
    cwd: "",
    lastTime: 0,
    firstTime: undefined as number | undefined,
    count: 0,
    humanOrigin: false,
    realUserText: false,
    firstUser: undefined as string | undefined,
    firstRealUser: undefined as string | undefined,
    customTitle: undefined as string | undefined,
  }
  const messages: ImportedMessage[] = []

  const push = (raw: string) => {
    if (CUSTOM_TITLE.test(raw)) {
      const record = asRecord(parseLine(raw))
      if (record?.type === "custom-title") {
        const title = asString(record.customTitle)?.trim()
        if (title) state.customTitle = title
        return
      }
    }
    if (!MESSAGE_TYPE.test(raw) || !HAS_TEXT.test(raw)) return
    const record = asRecord(parseLine(raw))
    if (!record) return
    if (record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true) return
    const type = record.type
    if (type !== "user" && type !== "assistant") return
    const message = asRecord(record.message)
    if (!message) return
    const text = textOf(message.content)
    if (!text) return
    if (type === "user" && COMMAND_WRAPPER.test(text)) return

    if (!state.sessionID) state.sessionID = asString(record.sessionId) ?? ""
    if (!state.cwd) state.cwd = asString(record.cwd) ?? ""
    if (type === "user") {
      if (hasHumanOrigin(record)) state.humanOrigin = true
      if (!isSyntheticUserText(text)) {
        state.realUserText = true
        state.firstRealUser ??= text
      }
      state.firstUser ??= text
    }
    const stamp = asString(record.timestamp)
    const parsedTime = stamp ? Date.parse(stamp) : Number.NaN
    const time = Number.isFinite(parsedTime) ? parsedTime : state.lastTime
    state.lastTime = time
    state.firstTime ??= time
    state.count++
    if (options.keepMessages) messages.push({ role: type, text, time })
  }

  const finish = (): ParsedSession => {
    const sourceSessionID = state.sessionID || path
    if (!state.humanOrigin && !state.realUserText)
      return { sourceSessionID, sourcePath: path, cwd: state.cwd, title: "", messages: [], messageCount: 0, time: 0 }
    const firstUser = state.firstRealUser ?? state.firstUser
    const fallback = path.split("/").at(-2) ?? path
    return {
      sourceSessionID,
      sourcePath: path,
      cwd: state.cwd,
      title: (state.customTitle ?? (firstUser ? titleText(firstUser) : fallback)).slice(0, TITLE_LIMIT),
      messages,
      messageCount: state.count,
      time: state.firstTime ?? 0,
    }
  }

  return { push, finish, cwd: () => state.cwd || undefined }
}

function parseLine(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
