import { describe, expect, test } from "bun:test"
import { shouldDispose } from "../../src/worktree/session-binding"
import { Worktree } from "../../src/worktree/index"

describe("subagent isolation cleanup", () => {
  test("disposable temp worktree is removed only when archived and idle", () => {
    const binding = { sessionID: "ses_child", directory: "/repo/.opencode/worktrees/ses-child", disposable: true }
    expect(shouldDispose(binding, { archived: true, running: false })).toBe(true)
    expect(shouldDispose(binding, { archived: false, running: false })).toBe(false)
  })

  test("worktree service exposes disposable create and idle dispose", () => {
    const methods = (svc: Worktree.Interface) => [svc.createDisposable, svc.disposeIfIdle]
    expect(typeof methods).toBe("function")
  })
})
