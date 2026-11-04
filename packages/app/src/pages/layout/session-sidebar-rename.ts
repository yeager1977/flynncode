import { createStore } from "solid-js/store"

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
  // A store, not Maps: rows read this in JSX, and only a store tells them to re-render when a rename starts or the
  // draft changes. An entry holds `undefined` once removed, so an emptied draft ("") still counts as renaming.
  const [state, setState] = createStore({
    drafts: {} as Record<string, string | undefined>,
    titles: {} as Record<string, string | undefined>,
  })

  return {
    start(sessionID, title) {
      setState("drafts", sessionID, title)
    },
    stop(sessionID) {
      setState("drafts", sessionID, undefined)
    },
    setDraft(sessionID, draft) {
      setState("drafts", sessionID, draft)
    },
    setOptimisticTitle(sessionID, title) {
      setState("titles", sessionID, title)
    },
    clearOptimisticTitle(sessionID) {
      setState("titles", sessionID, undefined)
    },
    synced(sessionID, title) {
      if (state.titles[sessionID] === title) setState("titles", sessionID, undefined)
    },
    renaming: (sessionID) => state.drafts[sessionID] !== undefined,
    draft: (sessionID) => state.drafts[sessionID],
    optimisticTitle: (sessionID) => state.titles[sessionID],
  }
}
