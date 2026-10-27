import { Cause, Effect, Semaphore } from "effect"
import fs from "fs/promises"
import { join } from "path"
import { Global } from "@flynncode/core/global"
import type { SessionV1 } from "@flynncode/core/v1/session"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

// Claude-format hooks read `transcript_path` as JSONL, one object per message
// (e.g. `tail -n 4 | jq -s .`). This keeps a per-session file in that shape,
// derived from the session's own messages:
// - text parts become `text` blocks; file parts become a short `[file: ...]`
//   text note; reasoning, step and every other part type are skipped.
// - a completed or errored tool part becomes a `tool_use` block on the
//   assistant line, and the message's results follow on one `user` line of
//   `tool_result` blocks (uuid `<messageID>:tool_result`). Pending and running
//   tools are skipped.
// - the file is append-only; `<sessionID>.cursor` holds the last message id
//   written. If that id is no longer in the session (revert, rewrite) the file
//   is rebuilt from scratch.

const lock = Semaphore.makeUnsafe(1)

export const directory = () => join(Global.Path.data, "claude-transcripts")

export const path = (sessionID: string) => join(directory(), `${sessionID}.jsonl`)

export const sync = Effect.fn("ClaudeTranscript.sync")(function* (input: { sessionID: string }) {
  const session = yield* Session.Service
  const file = path(input.sessionID)
  return yield* lock.withPermits(1)(write(session, input.sessionID, file)).pipe(
    Effect.as(file),
    Effect.catchCause((cause) =>
      Effect.logWarning("claude transcript sync failed", { sessionID: input.sessionID, cause: Cause.pretty(cause) }).pipe(
        // A failed append can still leave an earlier good file behind.
        Effect.andThen(Effect.promise(() => Bun.file(file).exists())),
        Effect.map((exists) => (exists ? file : "")),
      ),
    ),
  )
})

// Removes the transcript and cursor of a deleted session.
export const remove = (sessionID: string) =>
  Effect.promise(() =>
    Promise.all([
      fs.rm(path(sessionID), { force: true }),
      fs.rm(cursorPath(sessionID), { force: true }),
    ]),
  ).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("claude transcript removal failed", { sessionID, cause: Cause.pretty(cause) }),
    ),
  )

const cursorPath = (sessionID: string) => join(directory(), `${sessionID}.cursor`)

const write = Effect.fn("ClaudeTranscript.write")(function* (session: Session.Interface, id: string, file: string) {
  const sessionID = SessionID.make(id)
  const info = yield* session.get(sessionID)
  const all = yield* session.messages({ sessionID })
  yield* Effect.promise(() => fs.mkdir(directory(), { recursive: true }))
  const cursor = yield* Effect.promise(() =>
    Bun.file(cursorPath(id))
      .text()
      .then((text) => text.trim())
      .catch(() => ""),
  )
  const at = cursor === "" ? -1 : all.findIndex((message) => message.info.id === cursor)
  const rebuild = at === -1
  // The last line written belongs to the nearest message at or before the cursor that produced one.
  const parent = rebuild
    ? null
    : (all
        .slice(0, at + 1)
        .reverse()
        .values()
        .map(blocks)
        .find((written) => written.length > 0)
        ?.at(-1)?.uuid ?? null)

  // Only the last message can still be streaming: anything earlier is final.
  // Stop at the first unsettled message so the cursor stays a single id.
  const settled = all.slice(at + 1).filter((message, index, rest) => index < rest.length - 1 || isSettled(message))
  const lines = settled.flatMap((message) =>
    blocks(message).map((line) => ({ ...line, sessionId: id, cwd: info.directory })),
  )
  const chained = lines.map((line, index) => ({
    ...line,
    parentUuid: index === 0 ? parent : lines[index - 1]?.uuid,
  }))
  const text = chained.map((line) => JSON.stringify(line) + "\n").join("")
  yield* Effect.promise(() => (rebuild ? fs.writeFile(file, text) : fs.appendFile(file, text)))
  const last = settled.at(-1)
  if (last) yield* Effect.promise(() => Bun.write(cursorPath(id), last.info.id))
})

function isSettled(message: SessionV1.WithParts) {
  if (message.info.role === "user") return message.parts.some((part) => part.type === "text" || part.type === "file")
  if (message.info.time.completed === undefined && !message.info.error) return false
  return message.parts.every((part) => part.type !== "tool" || !["pending", "running"].includes(part.state.status))
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }

function blocks(message: SessionV1.WithParts) {
  const role = message.info.role
  const timestamp = new Date(message.info.time.created).toISOString()
  const content = message.parts.flatMap((part): Block[] => {
    if (part.type === "text") return part.ignored ? [] : [{ type: "text", text: part.text }]
    if (part.type === "file") return [{ type: "text", text: `[file: ${part.filename ?? "unnamed"} (${part.mime})]` }]
    if (part.type !== "tool") return []
    if (part.state.status === "completed" || part.state.status === "error")
      return [{ type: "tool_use", id: part.callID, name: part.tool, input: part.state.input }]
    return []
  })
  const results = message.parts.flatMap((part): Block[] => {
    if (part.type !== "tool") return []
    if (part.state.status === "completed")
      return [{ type: "tool_result", tool_use_id: part.callID, content: part.state.output, is_error: false }]
    if (part.state.status === "error")
      return [{ type: "tool_result", tool_use_id: part.callID, content: part.state.error, is_error: true }]
    return []
  })
  return [
    ...(content.length > 0
      ? [{ type: role, message: { role, content }, uuid: message.info.id as string, timestamp }]
      : []),
    ...(results.length > 0
      ? [
          {
            type: "user" as const,
            message: { role: "user" as const, content: results },
            uuid: `${message.info.id}:tool_result`,
            timestamp,
          },
        ]
      : []),
  ]
}

export * as ClaudeTranscript from "./claude-transcript"
