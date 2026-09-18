export * as ClaudeCode from "./claude-code"

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

export function parseClaudeCode(input: { readonly path: string; readonly text: string }): ParsedSession {
  let sessionID = ""
  let cwd = ""
  let lastTime = 0
  const messages: ImportedMessage[] = []

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
    const stamp = asString(record.timestamp)
    const parsedTime = stamp ? Date.parse(stamp) : Number.NaN
    const time = Number.isFinite(parsedTime) ? parsedTime : lastTime
    lastTime = time
    messages.push({ role: type, text, time })
  }

  const firstUser = messages.find((message) => message.role === "user")
  const fallback = input.path.split("/").at(-2) ?? input.path
  const title = (firstUser?.text ?? fallback).slice(0, TITLE_LIMIT)

  return {
    sourceSessionID: sessionID || input.path,
    sourcePath: input.path,
    cwd,
    title,
    messages,
  }
}