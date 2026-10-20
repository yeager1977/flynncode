// The sidebar renames a session in an input inside the row. A refresh of the
// session list re-creates the row, so the rename state lives here, keyed by
// session id, and outlives the row.
export type RenameState = {
  readonly start: (sessionID: string, title: string) => void
  readonly stop: (sessionID: string) => void
  readonly setDraft: (sessionID: string, draft: string) => void
  readonly setOptimisticTitle: (sessionID: string, title: string) => void
  readonly clearOptimisticTitle: (sessionID: string) => void
  readonly synced: (sessionID: string, title: string) => void
  readonly renaming: (sessionID: string) => boolean
  readonly draft: (sessionID: string) => string | undefined
  readonly optimisticTitle: (sessionID: string) => string | undefined
}

export function createRenameState(): RenameState {
  const drafts = new Map<string, string>()
  const titles = new Map<string, string>()

  return {
    start(sessionID, title) {
      drafts.set(sessionID, title)
    },
    stop(sessionID) {
      drafts.delete(sessionID)
    },
    setDraft(sessionID, draft) {
      drafts.set(sessionID, draft)
    },
    setOptimisticTitle(sessionID, title) {
      titles.set(sessionID, title)
    },
    clearOptimisticTitle(sessionID) {
      titles.delete(sessionID)
    },
    synced(sessionID, title) {
      if (titles.get(sessionID) === title) titles.delete(sessionID)
    },
    renaming: (sessionID) => drafts.has(sessionID),
    draft: (sessionID) => drafts.get(sessionID),
    optimisticTitle: (sessionID) => titles.get(sessionID),
  }
}
