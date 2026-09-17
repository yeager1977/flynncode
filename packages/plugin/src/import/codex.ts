import type { ImportedMessage, ParsedSession } from "./types.js"

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
const normalize = (value: string) => value.replace(/\s+/g, " ").trim()

export function parseCodex(input: { readonly path: string; readonly text: string }): ParsedSession {
  let sessionID = ""
  let cwd = ""
  let time = 0
  const messages: ImportedMessage[] = []

  const push = (role: ImportedMessage["role"], text: string) => {
    const previous = messages.at(-1)
    if (role === "assistant" && previous?.role === "assistant" && normalize(previous.text) === normalize(text)) return
    messages.push({ role, text, time })
  }

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
    const payload = asRecord(record.payload)
    if (!payload) continue
    const stamp = asString(record.timestamp)
    const parsedTime = stamp ? Date.parse(stamp) : Number.NaN
    if (Number.isFinite(parsedTime)) time = parsedTime

    if (record.type === "session_meta") {
      sessionID = asString(payload.id) ?? asString(payload.session_id) ?? ""
      cwd = asString(payload.cwd) ?? ""
      continue
    }

    if (record.type === "event_msg") {
      if (payload.type === "user_message") {
        const text = asString(payload.message)
        if (text?.trim()) push("user", text)
        continue
      }
      if (payload.type === "agent_message" && payload.phase === "final") {
        const text = asString(payload.message)
        if (text?.trim()) push("assistant", text)
        continue
      }
      continue
    }

    if (record.type === "response_item" && payload.type === "message") {
      const role = asString(payload.role)
      if (role !== "user" && role !== "assistant") continue
      const text = responseText(payload.content)
      if (!text) continue
      push(role, text)
    }
  }

  const firstUser = messages.find((message) => message.role === "user")
  const title = (firstUser?.text ?? input.path.split("/").at(-1) ?? input.path).slice(0, TITLE_LIMIT)

  return {
    sourceSessionID: sessionID || input.path,
    sourcePath: input.path,
    cwd,
    title,
    messages,
  }
}