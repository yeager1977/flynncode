import { describe, expect, test } from "bun:test"
import { worktreeDivider } from "../../session-ui/src/components/worktree-divider"
import { dict } from "../../ui/src/i18n/en"

const text = (metadata: Record<string, unknown>) => {
  const divider = worktreeDivider(metadata)
  if (!divider) return undefined
  return dict[divider.key].replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => divider.params[name] ?? "")
}

describe("worktreeDivider", () => {
  test("announces an entered worktree by its branch", () => {
    expect(text({ worktree: { action: "enter", branch: "flynn/fix-login", path: "/repo/.wt/fix-login" } })).toBe(
      "⎇ Entered worktree flynn/fix-login",
    )
  })

  test("names the folder when an entered worktree has no branch", () => {
    expect(text({ worktree: { action: "enter", path: "/repo/.wt/fix-login/" } })).toBe("⎇ Entered worktree fix-login")
  })

  test("says which folder a kept exit returns to", () => {
    expect(text({ worktree: { action: "exit", path: "/home/me/repo", from: "/repo/.wt/x", removed: false } })).toBe(
      "⎇ Back in repo (worktree kept)",
    )
  })

  test("says when the worktree was removed", () => {
    expect(text({ worktree: { action: "exit", path: "/home/me/repo", from: "/repo/.wt/x", removed: true } })).toBe(
      "⎇ Back in repo (worktree removed)",
    )
  })

  test("a pending removal wins over the removed flag", () => {
    expect(
      text({ worktree: { action: "exit", path: "/home/me/repo", from: "/repo/.wt/x", removed: false, pending: true } }),
    ).toBe("⎇ Back in repo (removal pending)")
  })

  test("ignores metadata that is not a worktree switch", () => {
    expect(worktreeDivider({})).toBeUndefined()
    expect(worktreeDivider({ worktree: "nope" })).toBeUndefined()
    expect(worktreeDivider({ worktree: null })).toBeUndefined()
    expect(worktreeDivider({ worktree: { action: "discard", path: "/x" } })).toBeUndefined()
    expect(worktreeDivider({ worktree: { action: "exit" } })).toBeUndefined()
    expect(worktreeDivider({ worktree: { action: "enter" } })).toBeUndefined()
  })
})
