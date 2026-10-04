import type { SessionApi, SessionInfo, SessionListInput } from "@opencode-ai/client/promise"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { withTimestampedFallback } from "./session-title"

export function normalizeSessionInfo(input: SessionInfo | Session): Session {
  if (!("location" in input)) return input
  return {
    id: input.id,
    slug: input.id,
    projectID: input.projectID,
    workspaceID: input.location.workspaceID,
    directory: input.location.directory,
    path: input.subpath,
    parentID: input.parentID,
    cost: input.cost,
    tokens: input.tokens,
    title: withTimestampedFallback(input),
    agent: input.agent,
    model: input.model,
    version: "",
    time: input.time,
    revert: input.revert && {
      messageID: input.revert.messageID,
      partID: input.revert.partID,
      snapshot: input.revert.snapshot,
    },
  }
}

export async function listAllSessions(
  api: Pick<SessionApi, "list">,
  input: Omit<SessionListInput, "cursor">,
  cap = Number.POSITIVE_INFINITY,
) {
  const load = async (cursor?: string): Promise<{ sessions: Session[]; truncated: boolean }> => {
    const result = await api.list({ ...input, limit: input.limit ?? 100, cursor })
    const sessions = result.data.map(normalizeSessionInfo)
    // Cap the recursion so a huge server cannot stall the cleanup scan
    // indefinitely; callers surface truncation via `truncated`.
    const total = sessions.length
    if (total >= cap) return { sessions, truncated: true }
    if (result.data.length === 0 || !result.cursor.next) return { sessions, truncated: false }
    const next = await load(result.cursor.next)
    return { sessions: [...sessions, ...next.sessions], truncated: next.truncated }
  }
  return load()
}
