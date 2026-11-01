import { Cause, Effect, Semaphore } from "effect"
import fs from "fs/promises"
import { join } from "path"
import { Global } from "@flynncode/core/global"
import type { SessionV1 } from "@flynncode/core/v1/session"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ClaudeFormat } from "@/hooks/claude-format"

// Claude-format hooks read `transcript_path` as JSONL, one object per message
// (e.g. `tail -n 4 | jq -s .`). This keeps a per-session file in that shape,
// derived from the session's own messages:
// - text parts become `text` blocks; file parts become a short `[file: ...]`
//   text note; reasoning, step and every other part type are skipped.
// - a completed or errored tool part becomes a `tool_use` block on the
//   assistant line, under its Claude tool name and with Claude's argument
//   keys (as hook stdin has them), and the message's results follow on one
//   `user` line of `tool_result` blocks (uuid `<messageID>:tool_result`).
//   Pending and running tools are skipped.
// - the file is append-only; `<sessionID>.cursor` holds the last message id
//   written and, on its second line, the last line's uuid (the next line's
//   parent). If that id is no longer in the session (revert, rewrite), the
//   file is missing or the cursor predates the uuid line, the file is rebuilt
//   from scratch.
// - a sync reads messages newest-first and stops at the cursor, so one with
//   nothing new reads the last two messages only.

// One sync per session at a time. An entry lives only while a sync holds or
// waits for it.
const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>()

export const directory = () => join(Global.Path.data, "claude-transcripts")

export const path = (sessionID: string) => join(directory(), `${sessionID}.jsonl`)

// `toolName` gives a tool id's Claude name; the executor passes one that
// knows MCP servers. Without it, MCP tools keep their Flynncode id.
export const sync = Effect.fn("ClaudeTranscript.sync")(function* (input: {
  sessionID: string
  toolName?: (id: string) => Effect.Effect<string>
}) {
  const session = yield* Session.Service
  const file = path(input.sessionID)
  const name = input.toolName ?? ((id: string) => Effect.succeed(ClaudeFormat.toolName(id)))
  return yield* locked(input.sessionID, write(session, input.sessionID, file, name)).pipe(
    Effect.as(file),
    Effect.catchCause((cause) =>
      Effect.logWarning("claude transcript sync failed", { sessionID: input.sessionID, cause: Cause.pretty(cause) }).pipe(
        // A failed append can still leave an earlier good file behind.
        Effect.andThen(Effect.promise(() => exists(file))),
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

const locked = <A, E, R>(sessionID: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const entry = locks.get(sessionID) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      entry.users += 1
      locks.set(sessionID, entry)
      return entry
    }),
    (entry) => entry.semaphore.withPermits(1)(self),
    (entry) =>
      Effect.sync(() => {
        entry.users -= 1
        if (entry.users === 0) locks.delete(sessionID)
      }),
  )

const write = Effect.fn("ClaudeTranscript.write")(function* (
  session: Session.Interface,
  id: string,
  file: string,
  name: (id: string) => Effect.Effect<string>,
) {
  const sessionID = SessionID.make(id)
  const cursor = yield* readCursor(id, file)
  const pending = cursor
    ? yield* unwritten(session, sessionID, cursor.id, 2)
    : { rebuild: true, messages: yield* session.messages({ sessionID }) }
  // Only the last message can still be streaming: anything earlier is final.
  // Stop at the first unsettled message so the cursor stays a single id.
  const settled = pending.messages.filter(
    (message, index, rest) => index < rest.length - 1 || isSettled(message),
  )
  if (!pending.rebuild && settled.length === 0) return

  const info = yield* session.get(sessionID)
  const ids = [...new Set(settled.flatMap((message) => message.parts.flatMap((part) => (part.type === "tool" ? [part.tool] : []))))]
  const names = new Map(yield* Effect.forEach(ids, (tool) => name(tool).pipe(Effect.map((claude) => [tool, claude] as const))))
  const lines = settled.flatMap((message) =>
    blocks(message, names).map((line) => ({ ...line, sessionId: id, cwd: info.directory })),
  )
  const parent = pending.rebuild ? null : (cursor?.uuid ?? null)
  const chained = lines.map((line, index) => ({
    ...line,
    parentUuid: index === 0 ? parent : lines[index - 1]?.uuid,
  }))
  const text = chained.map((line) => JSON.stringify(line) + "\n").join("")
  yield* Effect.promise(() => fs.mkdir(directory(), { recursive: true }))
  yield* Effect.promise(() => (pending.rebuild ? fs.writeFile(file, text) : fs.appendFile(file, text)))
  const last = settled.at(-1)
  if (last) {
    yield* Effect.promise(() => fs.writeFile(cursorPath(id), `${last.info.id}\n${chained.at(-1)?.uuid ?? parent ?? ""}`))
    return
  }
  // A rebuild with nothing settled must not keep a cursor into the old file.
  yield* Effect.promise(() => fs.rm(cursorPath(id), { force: true }))
})

// The cursor, or undefined when the file must be rebuilt.
const readCursor = (id: string, file: string) =>
  Effect.promise(async () => {
    const text = await fs.readFile(cursorPath(id), "utf8").catch(() => "")
    const lines = text.split("\n")
    if (lines.length < 2 || lines[0] === "" || !(await exists(file))) return undefined
    return { id: lines[0], uuid: lines[1] || null }
  })

// The messages after the cursor, oldest first, read newest-first in growing
// windows until the cursor turns up. A window shorter than its limit holds
// the whole session; if the cursor is not in it, the file is rebuilt from it.
function unwritten(
  session: Session.Interface,
  sessionID: SessionID,
  cursor: string,
  limit: number,
): Effect.Effect<{ rebuild: boolean; messages: Array<SessionV1.WithParts> }, Session.NotFound> {
  return Effect.gen(function* () {
    const recent = yield* session.messages({ sessionID, limit })
    const at = recent.findIndex((message) => message.info.id === cursor)
    if (at !== -1) return { rebuild: false, messages: recent.slice(at + 1) }
    if (recent.length < limit) return { rebuild: true, messages: recent }
    return yield* unwritten(session, sessionID, cursor, limit * 8)
  })
}

function isSettled(message: SessionV1.WithParts) {
  if (message.info.role === "user") return message.parts.some((part) => part.type === "text" || part.type === "file")
  if (message.info.time.completed === undefined && !message.info.error) return false
  return message.parts.every((part) => part.type !== "tool" || !["pending", "running"].includes(part.state.status))
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }

function blocks(message: SessionV1.WithParts, names: Map<string, string>) {
  const role = message.info.role
  const timestamp = new Date(message.info.time.created).toISOString()
  const content = message.parts.flatMap((part): Block[] => {
    if (part.type === "text") return part.ignored ? [] : [{ type: "text", text: part.text }]
    if (part.type === "file") return [{ type: "text", text: `[file: ${part.filename ?? "unnamed"} (${part.mime})]` }]
    if (part.type !== "tool") return []
    if (part.state.status === "completed" || part.state.status === "error")
      return [
        {
          type: "tool_use",
          id: part.callID,
          name: names.get(part.tool) ?? ClaudeFormat.toolName(part.tool),
          input: ClaudeFormat.toClaudeArgs(part.tool, part.state.input),
        },
      ]
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

// Matches Bun.file().exists(): only a regular file counts.
const exists = (file: string) =>
  fs.stat(file).then(
    (info) => info.isFile(),
    () => false,
  )

export * as ClaudeTranscript from "./claude-transcript"
