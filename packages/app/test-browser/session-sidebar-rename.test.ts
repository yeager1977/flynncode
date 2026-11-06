import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createRenameState } from "../src/pages/layout/session-sidebar-rename"

// A sidebar row reads this state in JSX and effects. State Solid cannot track never re-renders the row, so choosing
// Rename in the row menu changed nothing on screen: the link never became an input.
describe("createRenameState reactivity", () => {
  test("a computation reading a rename sees it start, change and stop", () => {
    const state = createRenameState()
    const row = createRoot((dispose) => ({
      dispose,
      renaming: createMemo(() => state.renaming("ses_1")),
      draft: createMemo(() => state.draft("ses_1")),
    }))
    expect(row.renaming()).toBe(false)

    state.start("ses_1", "Old title")
    expect(row.renaming()).toBe(true)
    expect(row.draft()).toBe("Old title")

    state.setDraft("ses_1", "")
    // An emptied input is still a rename in progress.
    expect(row.renaming()).toBe(true)
    expect(row.draft()).toBe("")

    state.stop("ses_1")
    expect(row.renaming()).toBe(false)
    expect(row.draft()).toBeUndefined()
    row.dispose()
  })

  test("a computation reading the optimistic title sees it set, cleared and synced", () => {
    const state = createRenameState()
    const row = createRoot((dispose) => ({ dispose, title: createMemo(() => state.optimisticTitle("ses_1")) }))
    expect(row.title()).toBeUndefined()

    state.setOptimisticTitle("ses_1", "New title")
    expect(row.title()).toBe("New title")

    state.synced("ses_1", "Something else")
    expect(row.title()).toBe("New title")
    state.synced("ses_1", "New title")
    expect(row.title()).toBeUndefined()

    state.setOptimisticTitle("ses_1", "Again")
    state.clearOptimisticTitle("ses_1")
    expect(row.title()).toBeUndefined()
    row.dispose()
  })

  test("a rename on one session does not disturb another session's computation", () => {
    const state = createRenameState()
    let runs = 0
    const row = createRoot((dispose) => ({
      dispose,
      renaming: createMemo(() => {
        runs += 1
        return state.renaming("ses_2")
      }),
    }))
    const before = runs

    state.start("ses_1", "One")
    expect(row.renaming()).toBe(false)
    expect(runs).toBe(before)
    row.dispose()
  })
})
