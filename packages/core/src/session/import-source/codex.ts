export * as Codex from "./codex"

import type { ImportedMessage, ParsedSession, SessionReader } from "./types.js"

type Record_ = Record<string, unknown>

const asRecord = (value: unknown): Record_ | undefined =>
  typeof value === "object" && value !== null ? (value as Record_) : undefined

const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

// Codex Desktop records the user's prompts as `input_text` blocks; replies
// use `output_text`.
const TEXT_BLOCKS = new Set(["input_text", "output_text", "text"])

function responseText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined
  if (!Array.isArray(content)) return
  const blocks = content.flatMap((block) => {
    const item = asRecord(block)
    if (!item) return []
    if (!TEXT_BLOCKS.has(asString(item.type) ?? "")) return []
    const text = asString(item.text)
    return text ? [text] : []
  })
  if (!blocks.length) return
  return blocks.join("\n\n")
}

const TITLE_LIMIT = 80

// Context Codex injects as user turns: AGENTS.md instructions and tagged
// blocks such as <environment_context> or <external_codex_apps_open_page>.
const INJECTED_USER_TEXT = /^\s*(<[a-z][\w-]*[\s>]|# AGENTS\.md instructions)/i

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
    // Older rollouts record each prompt both as an event_msg and a response_item.
    lastUser: undefined as string | undefined,
    subagent: false,
  }
  const messages: ImportedMessage[] = []

  const add = (role: "user" | "assistant", text: string) => {
    if (role === "user" && text === state.lastUser) return
    state.lastUser = role === "user" ? text : undefined
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
      // Subagent threads belong to their parent thread, like Claude Code sidechains.
      state.subagent = payload.thread_source === "subagent" || asRecord(asRecord(payload.source)?.subagent) !== undefined
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
      if (!text) return
      if (role === "user" && INJECTED_USER_TEXT.test(text)) return
      add(role, text)
    }
  }

  const finish = (): ParsedSession => ({
    sourceSessionID: state.sessionID || path,
    sourcePath: path,
    cwd: state.cwd,
    title: (state.firstUser ?? path.split("/").at(-1) ?? path).slice(0, TITLE_LIMIT),
    messages: state.subagent ? [] : messages,
    messageCount: state.subagent ? 0 : state.count,
    time: state.firstTime ?? 0,
  })

  return { push, finish, cwd: () => state.cwd || undefined }
}

// Codex keeps thread names (including renames) in ~/.codex/session_index.jsonl,
// one {id, thread_name} line per change; the latest line for an id wins.
export function codexThreadNames(lines: Iterable<string>): Map<string, string> {
  const names = new Map<string, string>()
  for (const raw of lines) {
    const record = asRecord(parseLine(raw))
    const id = asString(record?.id)
    const name = asString(record?.thread_name)?.trim()
    if (id && name) names.set(id, name)
  }
  return names
}

function parseLine(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
