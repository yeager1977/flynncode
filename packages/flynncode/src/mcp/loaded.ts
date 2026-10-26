export * as McpLoaded from "./loaded"

import { Effect, Semaphore } from "effect"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"

// setMetadata replaces the whole metadata object, so read-merge-write must not
// interleave: parallel tool_search calls would otherwise drop each other's ids.
const lock = Semaphore.makeUnsafe(1)

/** Deferred MCP tool ids this session has loaded through tool_search. */
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
 * Drop loaded ids that are not in `valid` (the MCP tool ids that currently exist), preserving
 * every other metadata key. Skips the write when nothing is stale. Never fails: a failed write
 * is logged and the surviving ids are still returned.
 */
export function prune(sessions: Session.Interface, sessionID: SessionID, valid: ReadonlySet<string>) {
  return update(sessions, sessionID, [], (existing) => existing.filter((id) => valid.has(id)))
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
