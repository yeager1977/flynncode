import type { ImportedMessage, ParsedSession } from "./types.js"

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

// Claude Code prepends context to the first human turn as one or more
// <system-reminder> blocks. Strip them from titles so the title reflects what
// the user actually asked, not the injected worktree/skill boilerplate.
const LEADING_REMINDERS = /^\s*(<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/

const titleText = (text: string) => {
  const withoutReminders = text.replace(LEADING_REMINDERS, "").trim()
  return withoutReminders || text.trim()
}

const hasHumanOrigin = (record: Record_) => {
  const origin = asRecord(record.origin)
  return origin?.kind === "human"
}

export function parseClaudeCode(input: { readonly path: string; readonly text: string }): ParsedSession {
  let sessionID = ""
  let cwd = ""
  let lastTime = 0
  const messages: ImportedMessage[] = []
  let humanOrigin = false
  let realUserText = false

  for (const raw of input.text.split("\n")) {
    if (!raw.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    if (!record) continue
    if (record.isSidechain === true) continue
    const type = record.type
    if (type !== "user" && type !== "assistant") continue
    const message = asRecord(record.message)
    if (!message) continue
    const text = textOf(message.content)
    if (!text) continue

    if (!sessionID) sessionID = asString(record.sessionId) ?? ""
    if (!cwd) cwd = asString(record.cwd) ?? ""
    if (type === "user") {
      if (hasHumanOrigin(record)) humanOrigin = true
      if (!isSyntheticUserText(text)) realUserText = true
    }
    const stamp = asString(record.timestamp)
    const parsedTime = stamp ? Date.parse(stamp) : Number.NaN
    const time = Number.isFinite(parsedTime) ? parsedTime : lastTime
    lastTime = time
    messages.push({ role: type, text, time })
  }

  if (!humanOrigin && !realUserText) {
    return {
      sourceSessionID: sessionID || input.path,
      sourcePath: input.path,
      cwd,
      title: "",
      messages: [],
    }
  }

  const firstUser =
    messages.find((message) => message.role === "user" && !isSyntheticUserText(message.text)) ??
    messages.find((message) => message.role === "user")
  const fallback = input.path.split("/").at(-2) ?? input.path
  const title = (firstUser ? titleText(firstUser.text) : fallback).slice(0, TITLE_LIMIT)

  return {
    sourceSessionID: sessionID || input.path,
    sourcePath: input.path,
    cwd,
    title,
    messages,
  }
}