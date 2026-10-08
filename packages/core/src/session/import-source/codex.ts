export * as Codex from "./codex"

import type { ImportedMessage, ParsedSession, SessionReader } from "./types.js"

type Record_ = Record<string, unknown>

const asRecord = (value: unknown): Record_ | undefined =>
  typeof value === "object" && value !== null ? (value as Record_) : undefined

const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

function responseText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined
  if (!Array.isArray(content)) return
  const blocks = content.flatMap((block) => {
    const item = asRecord(block)
    if (!item) return []
    if (item.type !== "output_text" && item.type !== "text") return []
    const text = asString(item.text)
    return text ? [text] : []
  })
  if (!blocks.length) return
  return blocks.join("\n\n")
}

const TITLE_LIMIT = 80

// Only session metadata, user messages, and message response items matter;
// other records (reasoning, tool calls and outputs) skip JSON.parse.
const RELEVANT = /"type"\s*:\s*"(session_meta|user_message|message)"/

export function parseCodex(input: { readonly path: string; readonly text: string }): ParsedSession {
  const reader = codexReader(input.path, { keepMessages: true })
  for (const raw of input.text.split("\n")) reader.push(raw)
  return reader.finish()
}

// Incremental parser; see claudeCodeReader for the `keepMessages` contract.
export function codexReader(path: string, options: { readonly keepMessages: boolean }): SessionReader {
  const state = {
    sessionID: "",
    cwd: "",
    time: 0,
    firstTime: undefined as number | undefined,
    count: 0,
    firstUser: undefined as string | undefined,
  }
  const messages: ImportedMessage[] = []

  const add = (role: "user" | "assistant", text: string) => {
    if (role === "user") state.firstUser ??= text
    state.firstTime ??= state.time
    state.count++
    if (options.keepMessages) messages.push({ role, text, time: state.time })
  }

  const push = (raw: string) => {
    if (!RELEVANT.test(raw)) return
    const record = asRecord(parseLine(raw))
    if (!record) return
    const payload = asRecord(record.payload)
    if (!payload) return
    const stamp = asString(record.timestamp)
    const parsedTime = stamp ? Date.parse(stamp) : Number.NaN
    if (Number.isFinite(parsedTime)) state.time = parsedTime

    if (record.type === "session_meta") {
      state.sessionID = asString(payload.id) ?? asString(payload.session_id) ?? ""
      state.cwd = asString(payload.cwd) ?? ""
      return
    }

    if (record.type === "event_msg") {
      const text = payload.type === "user_message" ? asString(payload.message) : undefined
      if (text?.trim()) add("user", text)
      return
    }

    if (record.type === "response_item" && payload.type === "message") {
      const role = asString(payload.role)
      if (role !== "user" && role !== "assistant") return
      const text = responseText(payload.content)
      if (text) add(role, text)
    }
  }

  const finish = (): ParsedSession => ({
    sourceSessionID: state.sessionID || path,
    sourcePath: path,
    cwd: state.cwd,
    title: (state.firstUser ?? path.split("/").at(-1) ?? path).slice(0, TITLE_LIMIT),
    messages,
    messageCount: state.count,
    time: state.firstTime ?? 0,
  })

  return { push, finish, cwd: () => state.cwd || undefined }
}

function parseLine(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
