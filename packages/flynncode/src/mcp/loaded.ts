export * as McpLoaded from "./loaded"

import { Effect, Semaphore } from "effect"
import type { SessionV1 } from "@flynncode/core/v1/session"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { McpCatalog } from "./catalog"

// setMetadata replaces the whole metadata object, so read-merge-write must not
// interleave: parallel mcp_tool_search calls would otherwise drop each other's ids.
const lock = Semaphore.makeUnsafe(1)

/** Deferred MCP tool ids this session has loaded through mcp_tool_search. */
export function get(session: Pick<Session.Info, "metadata">) {
  const value = session.metadata?.mcpLoaded
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === "string")
}

/**
 * Merge `ids` into the session's loaded set, preserving every other metadata key.
 * Never fails: a failed write is logged and the merged set is still returned so the
 * caller can proceed in memory.
 */
export function add(sessions: Session.Interface, sessionID: SessionID, ids: ReadonlyArray<string>) {
  return update(sessions, sessionID, ids, (existing) => [
    ...existing,
    ...ids.filter((id, index) => !existing.includes(id) && ids.indexOf(id) === index),
  ])
}

/**
 * Keep only the loaded ids for which `keep` holds, preserving every other metadata key. Skips the
 * write when nothing is dropped. Never fails: a failed write is logged and the surviving ids are
 * still returned.
 */
export function prune(sessions: Session.Interface, sessionID: SessionID, keep: (id: string) => boolean) {
  return update(sessions, sessionID, [], (existing) => existing.filter(keep))
}

/**
 * The loaded set for one provider step: the persisted set plus every id that a completed
 * mcp_tool_search call in `messages` loaded, so a failed metadata write or session read never hides a
 * tool the model has just loaded. Persistently drops only ids whose server is connected and no
 * longer lists them; ids of disconnected or failed servers stay persisted and come back on
 * reconnect. The result may hold ids that do not exist right now: the planner only looks at
 * existing tools, so those are never sent.
 */
export function current(input: {
  sessions: Session.Interface
  sessionID: SessionID
  messages: ReadonlyArray<SessionV1.WithParts>
  tools: ReadonlySet<string>
  servers: Record<string, { status: string }>
}) {
  return prune(input.sessions, input.sessionID, (id) => input.tools.has(id) || !removed(id, input.servers)).pipe(
    Effect.map((persisted) => [...new Set([...persisted, ...fromMessages(input.messages)])]),
  )
}

/** Ids loaded by completed mcp_tool_search calls in `messages`. Histories recorded before the rename still say tool_search. */
export function fromMessages(messages: ReadonlyArray<SessionV1.WithParts>) {
  return messages
    .flatMap((message) => message.parts)
    .flatMap((part) =>
      part.type === "tool" &&
      (part.tool === "mcp_tool_search" || part.tool === "tool_search") &&
      part.state.status === "completed" &&
      Array.isArray(part.state.metadata.loaded)
        ? part.state.metadata.loaded.filter((id: unknown): id is string => typeof id === "string")
        : [],
    )
}

// An id is gone for good only when every server whose prefix it carries is connected; a missing
// id of a disconnected server may just be waiting for the reconnect. Prefixes can overlap
// ("a" and "a_b"), so one offline match is enough to keep the id.
function removed(id: string, servers: Record<string, { status: string }>) {
  const owners = Object.entries(servers).filter(([name]) => id.startsWith(McpCatalog.toolName(name, "")))
  return owners.length > 0 && owners.every(([, server]) => server.status === "connected")
}

function update(
  sessions: Session.Interface,
  sessionID: SessionID,
  fallback: ReadonlyArray<string>,
  change: (existing: string[]) => string[],
) {
  return Effect.gen(function* () {
    const current = yield* sessions.get(sessionID)
    const existing = get(current)
    const next = change(existing)
    if (next.length === existing.length && next.every((id, index) => id === existing[index])) return existing
    return yield* sessions.setMetadata({ sessionID, metadata: { ...current.metadata, mcpLoaded: next } }).pipe(
      Effect.as(next),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to record loaded MCP tools", { sessionID, cause }).pipe(Effect.as(next)),
      ),
    )
  }).pipe(
    lock.withPermit,
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to read loaded MCP tools", { sessionID, cause }).pipe(Effect.as([...fallback])),
    ),
  )
}
