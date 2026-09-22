import type { Session } from "@opencode-ai/sdk/v2/client"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { pathKey } from "@/utils/path-key"
import { compareSessionTime } from "./helpers"

export type SessionDiffData = {
  session?: Session[]
  path?: { directory: string }
  session_diff: { [sessionID: string]: FileDiffInfo[] }
}

export type ArtifactFile = {
  file: string
  additions: number
  deletions: number
}

export type ArtifactGroup = {
  sessionID: string
  title: string
  directory: string
  updated: number
  files: ArtifactFile[]
}

const MAX_GROUPS = 20

export function groupSessionArtifacts(store: SessionDiffData, activeProjectDirectory: string): ArtifactGroup[] {
  const key = pathKey(activeProjectDirectory)
  if (!key) return []
  const visible = new Map(
    (store.session ?? [])
      .filter((session) => pathKey(session.directory) === key && !session.parentID && !session.time?.archived)
      .map((session) => [session.id, session] as const),
  )
  if (visible.size === 0) return []
  return Object.entries(store.session_diff)
    .filter(([sessionID, files]) => files.length > 0 && visible.has(sessionID))
    .map(([sessionID, files]) => {
      const session = visible.get(sessionID)!
      return {
        sessionID,
        title: session.title,
        directory: session.directory,
        updated: session.time.updated ?? session.time.created,
        files: files.map((item) => ({ file: item.file, additions: item.additions, deletions: item.deletions })),
      }
    })
    .sort((a, b) => compareSessionTime(visible.get(a.sessionID)!, visible.get(b.sessionID)!))
    .slice(0, MAX_GROUPS)
}