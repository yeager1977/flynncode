import { upstreamUrl } from "./upstream.ts"

export type InboxItem = {
  sessionID: string
  directory: string | undefined
  title: string
  kind: "permission" | "question"
  updated: number
}

export function groupInbox(input: {
  sessions: Array<{ id: string; title: string; directory: string | undefined; updated: number }>
  permissions: Array<{ sessionID: string; id: string }>
  questions: Array<{ sessionID: string; id: string }>
}): InboxItem[] {
  const known = new Map(input.sessions.map((session) => [session.id, session]))
  const items: InboxItem[] = []
  for (const request of input.permissions) {
    const session = known.get(request.sessionID)
    if (session === undefined) continue
    items.push({ sessionID: session.id, directory: session.directory, title: session.title, kind: "permission", updated: session.updated })
  }
  for (const request of input.questions) {
    const session = known.get(request.sessionID)
    if (session === undefined) continue
    items.push({ sessionID: session.id, directory: session.directory, title: session.title, kind: "question", updated: session.updated })
  }
  return items.sort((a, b) => b.updated - a.updated)
}

export type InboxLoad =
  | { kind: "loaded"; items: InboxItem[] }
  | { kind: "unauthorized" }
  | { kind: "unreachable" }

// Upstream shape (verified against packages/protocol/src/groups/permission.ts
// and groups/question.ts): pollable REST endpoints
//   GET <upstream>/api/permission/request -> { location, data: Permission.Request[] }
//   GET <upstream>/api/question/request   -> { location, data: Question.Request[] }
// where each Request carries { id, sessionID, ... }. Session metadata
// (title/directory/updated) comes from GET <upstream>/api/session?limit=30&order=desc
// ({ data: Session.Info[] }) — the same source loadLauncher uses. This avoids
// per-session fan-out and never touches the SSE event stream.
const TIMEOUT_MS = 5000
const RECENT_LIMIT = 30

export async function listNeedsInput(input: { upstream: string; authorization: string }): Promise<InboxLoad> {
  const [permissions, questions, recent] = await Promise.all([
    request(input, "http://gateway/api/permission/request"),
    request(input, "http://gateway/api/question/request"),
    request(input, `http://gateway/api/session?limit=${RECENT_LIMIT}&order=desc`),
  ])
  if (permissions.kind === "unauthorized" || questions.kind === "unauthorized" || recent.kind === "unauthorized") {
    return { kind: "unauthorized" }
  }
  if (permissions.kind === "failed" && questions.kind === "failed" && recent.kind === "failed") {
    return { kind: "unreachable" }
  }
  const sessions = parseSessions(recent.kind === "ok" ? recent.value : undefined)
  return {
    kind: "loaded",
    items: groupInbox({
      sessions,
      permissions: parseRequests(permissions.kind === "ok" ? permissions.value : undefined),
      questions: parseRequests(questions.kind === "ok" ? questions.value : undefined),
    }),
  }
}

type FetchOutcome = { kind: "ok"; value: unknown } | { kind: "unauthorized" } | { kind: "failed" }

async function request(input: { upstream: string; authorization: string }, url: string): Promise<FetchOutcome> {
  try {
    const response = await fetch(upstreamUrl(input.upstream, url), {
      headers: { authorization: input.authorization },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.status === 401 || response.status === 403) return { kind: "unauthorized" }
    if (!response.ok) return { kind: "failed" }
    return { kind: "ok", value: (await response.json()) as unknown }
  } catch {
    return { kind: "failed" }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRequests(value: unknown): Array<{ sessionID: string; id: string }> {
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  const out: Array<{ sessionID: string; id: string }> = []
  for (const item of value.data) {
    if (!isRecord(item)) continue
    if (typeof item.id !== "string" || !item.id) continue
    if (typeof item.sessionID !== "string" || !item.sessionID) continue
    out.push({ sessionID: item.sessionID, id: item.id })
  }
  return out
}

function parseSessions(value: unknown): Array<{ id: string; title: string; directory: string | undefined; updated: number }> {
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  const sessions: Array<{ id: string; title: string; directory: string | undefined; updated: number }> = []
  for (const item of value.data) {
    if (!isRecord(item)) continue
    if (typeof item.id !== "string" || !item.id) continue
    const location = isRecord(item.location) ? item.location : undefined
    const time = isRecord(item.time) ? item.time : undefined
    if (time && typeof time.archived === "number") continue
    sessions.push({
      id: item.id,
      title: typeof item.title === "string" && item.title.trim() ? item.title : item.id,
      directory: location && typeof location.directory === "string" ? location.directory : undefined,
      updated: time && typeof time.updated === "number" && Number.isFinite(time.updated) ? time.updated : 0,
    })
  }
  return sessions
}
