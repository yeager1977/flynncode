import { describe, expect, test } from "bun:test"
import { worktreesToRemove, type WorktreeRetentionEntry } from "../../src/worktree/retention"

describe("worktreesToRemove", () => {
  test("keeps the open session and any running session, and drops the oldest idle worktree past 15", () => {
    const entries: WorktreeRetentionEntry[] = Array.from({ length: 16 }, (_, index) => ({
      directory: `wt-${index}`,
      updated: index,
    }))
    entries.push({ directory: "running", updated: 0, running: true })
    entries.push({ directory: "open", updated: 1, open: true })
    const remove = worktreesToRemove(entries)
    expect(remove).toContain("wt-0")
    expect(remove).not.toContain("running")
    expect(remove).not.toContain("open")
    expect(remove).not.toContain("wt-15")
  })

  test("honors a custom keep limit from config", () => {
    const entries: WorktreeRetentionEntry[] = Array.from({ length: 5 }, (_, index) => ({
      directory: `wt-${index}`,
      updated: index,
    }))
    const remove = worktreesToRemove(entries, 2)
    // Newest stay, oldest past the limit are dropped.
    expect(remove.sort()).toEqual(["wt-0", "wt-1", "wt-2"])
  })

  test("a keep limit of zero still protects open and running worktrees", () => {
    const entries: WorktreeRetentionEntry[] = [
      { directory: "open", updated: 3, open: true },
      { directory: "running", updated: 2, running: true },
      { directory: "idle", updated: 1 },
    ]
    expect(worktreesToRemove(entries, 0).sort()).toEqual(["idle"])
  })
})
