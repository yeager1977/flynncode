import { describe, expect, test } from "bun:test"
import { createRenameState } from "./session-sidebar-rename"

describe("createRenameState", () => {
  test("keeps the draft for a session across a list refresh", () => {
    const state = createRenameState()
    state.start("ses_1", "Old title")

    // The row is re-created when the list is replaced; the state outlives it.
    state.start("ses_2", "Other")
    expect(state.draft("ses_1")).toBe("Old title")
    expect(state.renaming("ses_1")).toBe(true)
    expect(state.renaming("ses_2")).toBe(true)
  })

  test("tracks the draft separately per session", () => {
    const state = createRenameState()
    state.start("ses_1", "One")
    state.setDraft("ses_1", "Edited")
    state.start("ses_2", "Two")

    expect(state.draft("ses_1")).toBe("Edited")
    expect(state.draft("ses_2")).toBe("Two")
  })

  test("stops renaming and clears the draft", () => {
    const state = createRenameState()
    state.start("ses_1", "One")
    state.setDraft("ses_1", "Edited")
    state.stop("ses_1")

    expect(state.renaming("ses_1")).toBe(false)
    expect(state.draft("ses_1")).toBeUndefined()
  })

  test("keeps the optimistic title until the server reports it", () => {
    const state = createRenameState()
    state.start("ses_1", "One")
    state.setDraft("ses_1", "Edited")
    state.stop("ses_1")
    state.setOptimisticTitle("ses_1", "Edited")

    expect(state.renaming("ses_1")).toBe(false)
    expect(state.optimisticTitle("ses_1")).toBe("Edited")
  })

  test("drops the optimistic title once the server reports the same title", () => {
    const state = createRenameState()
    state.start("ses_1", "One")
    state.setDraft("ses_1", "Edited")
    state.stop("ses_1")
    state.setOptimisticTitle("ses_1", "Edited")

    state.synced("ses_1", "Edited")
    expect(state.optimisticTitle("ses_1")).toBeUndefined()
  })

  test("keeps the optimistic title while the server reports a different title", () => {
    const state = createRenameState()
    state.start("ses_1", "One")
    state.setDraft("ses_1", "Edited")
    state.stop("ses_1")
    state.setOptimisticTitle("ses_1", "Edited")

    state.synced("ses_1", "Something else")
    expect(state.optimisticTitle("ses_1")).toBe("Edited")
  })

  test("clears the optimistic title when the rename fails", () => {
    const state = createRenameState()
    state.setOptimisticTitle("ses_1", "Edited")
    state.clearOptimisticTitle("ses_1")

    expect(state.optimisticTitle("ses_1")).toBeUndefined()
  })
})
