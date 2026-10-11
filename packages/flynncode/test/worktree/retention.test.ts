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

describe("worktreesToRemove disposable", () => {
  test("never removes open or running entries and evicts stale disposables first", () => {
    const entries = [
      { directory: "/w/keep-open", updated: 1, open: true },
      { directory: "/w/keep-running", updated: 2, running: true },
      { directory: "/w/old", updated: 3 },
      { directory: "/w/new", updated: 4 },
      { directory: "/w/disposable", updated: 5, disposable: true, lastUsedAt: 0 },
    ]
    // NOTE: plan draft expected ["/w/disposable", "/w/old"], but under the
    // keep-first-`limit`-plus-protected logic /w/new and /w/old fill the two
    // keep slots, so only the stale disposable is evicted.
    expect(worktreesToRemove(entries, 2)).toEqual(["/w/disposable"])
  })

  test("orders disposables by lastUsedAt when past the limit", () => {
    const entries = [
      { directory: "/w/new", updated: 4 },
      { directory: "/w/old", updated: 3 },
      { directory: "/w/disposable", updated: 5, disposable: true, lastUsedAt: 0 },
    ]
    expect(worktreesToRemove(entries, 1)).toEqual(["/w/old", "/w/disposable"])
  })

  test("disposable entries are evicted by recency like any other", () => {
    const now = Date.now()
    const entries: WorktreeRetentionEntry[] = Array.from({ length: 16 }, (_, index) => ({
      directory: `wt-${index}`,
      updated: index,
      // #0 is disposable but freshest by lastUsedAt; the rest spread hourly.
      ...(index === 0
        ? { disposable: true, lastUsedAt: now - 1 }
        : { lastUsedAt: now - (index + 1) * 3_600_000 }),
    }))
    expect(worktreesToRemove(entries, 15)).toEqual([entries[15].directory])
  })

  test("a disposable entry with the newest lastUsedAt is kept despite a stale mtime", () => {
    const entries = [
      { directory: "/w/stale-mtime", updated: 100 },
      { directory: "/w/fresh-mtime", updated: 1, disposable: true, lastUsedAt: 1000 },
      { directory: "/w/mid", updated: 50 },
    ]
    expect(worktreesToRemove(entries, 2)).toEqual(["/w/mid"])
  })
})
