import type { ServerConnection } from "./server"
import type { DraftTab } from "./tabs"

// Only hidden draft tabs survive: sessions are navigated from the sidebar, so
// session tabs persisted before that are purged on load.
export function migrateTabs(value: unknown, fallback: ServerConnection.Key): DraftTab[] {
  if (!Array.isArray(value)) return []
  return value.flatMap<DraftTab>((tab) => {
    if (!tab || typeof tab !== "object") return []
    if ("server" in tab && typeof tab.server !== "string") return []
    const server = ("server" in tab ? tab.server : fallback) as ServerConnection.Key
    if (
      tab.type === "draft" &&
      typeof tab.draftID === "string" &&
      typeof tab.directory === "string" &&
      (tab.worktree === undefined || typeof tab.worktree === "string")
    ) {
      return [{ type: tab.type, server, draftID: tab.draftID, directory: tab.directory, worktree: tab.worktree }]
    }
    return []
  })
}
