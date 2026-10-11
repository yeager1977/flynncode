import { describe, expect, test } from "bun:test"
import { bindingKey, displayName, shouldDispose } from "../../src/worktree/session-binding"

describe("session-binding", () => {
  test("keys binding by session and directory", () => {
    expect(bindingKey("ses_1", "/repo/.opencode/worktrees/a")).toBe("ses_1::/repo/.opencode/worktrees/a")
  })

  test("disposes only archived non-running disposable bindings", () => {
    const binding = { sessionID: "ses_1", directory: "/w/a", disposable: true }
    expect(shouldDispose(binding, { archived: true, running: false })).toBe(true)
    expect(shouldDispose(binding, { archived: true, running: true })).toBe(false)
    expect(shouldDispose(binding, { archived: false, running: false })).toBe(false)
    expect(shouldDispose({ ...binding, disposable: false }, { archived: true, running: false })).toBe(false)
  })

  test("displays leaf name against project root", () => {
    expect(displayName("/repo/.opencode/worktrees/a", "/repo")).toBe("a")
  })
})
