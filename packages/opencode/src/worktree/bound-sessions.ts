import { Effect } from "effect"
import { FSUtil } from "@flynncode/core/fs-util"
import { Session } from "@/session/session"

// Canonicalize a worktree directory for comparison: resolve symlinks like
// the worktree service does, strip trailing slashes, and lowercase on
// Windows where the service canonicalizes the same way.
export function canonicalDir(directory: string): string {
  const resolved = FSUtil.resolve(directory).replace(/\/+$/, "") || directory
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

// Query variants covering the directory spellings session rows and callers
// use: rows store resolved paths while worktree listings canonicalize case
// on Windows. One variant on case-sensitive platforms.
function queryVariants(directory: string) {
  const resolved = FSUtil.resolve(directory).replace(/\/+$/, "") || directory
  return [...new Set([resolved, resolved.toLowerCase()])]
}

const pageSize = 200

// Every session bound to a directory, including archived ones, across all
// pages. The default list limit would silently truncate busy worktrees, so
// page to exhaustion (same cursor protocol as the session list endpoint).
export function boundSessions(sessions: Session.Interface, directory: string) {
  return Effect.gen(function* () {
    const seen = new Map<string, Session.GlobalInfo>()
    for (const variant of queryVariants(directory)) {
      let cursor: number | undefined = undefined
      while (true) {
        const page: Session.GlobalInfo[] = yield* sessions.listGlobal({
          directory: variant,
          archived: true,
          limit: pageSize + 1,
          ...(cursor === undefined ? {} : { cursor }),
        })
        for (const item of page.slice(0, pageSize)) seen.set(item.id, item)
        if (page.length <= pageSize) break
        const last: Session.GlobalInfo | undefined = page[pageSize - 1]
        if (last === undefined) break
        cursor = last.time.updated
      }
    }
    return [...seen.values()]
  })
}
