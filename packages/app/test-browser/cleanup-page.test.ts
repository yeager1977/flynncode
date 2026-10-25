import { describe, expect, test } from "bun:test"
import type { WorktreeCleanupReviewItem } from "@flynncode/sdk/v2/client"
import { formatBytes, groupByProject } from "@/hooks/use-worktree-cleanup"
import { selectionWarnings, selectable } from "@/pages/cleanup"

const item = (path: string, extra: Partial<WorktreeCleanupReviewItem> = {}): WorktreeCleanupReviewItem => ({
  path,
  project: "/repo",
  bytes: 1,
  capped: false,
  lastActivity: 0,
  reason: "recent",
  ...extra,
})

describe("groupByProject", () => {
  test("groups items by project and sorts groups by total size descending", () => {
    const groups = groupByProject([
      item("/a/1", { project: "/a", bytes: 10 }),
      item("/b/1", { project: "/b", bytes: 500 }),
      item("/a/2", { project: "/a", bytes: 30 }),
    ])
    expect(groups.map((group) => group.project)).toEqual(["/b", "/a"])
    expect(groups[1].bytes).toBe(40)
    expect(groups[1].items.map((entry) => entry.path)).toEqual(["/a/2", "/a/1"])
  })
})

describe("formatBytes", () => {
  test("prefixes capped sizes with a lower bound", () => {
    expect(formatBytes(44_000_000_000, true).startsWith("≥")).toBe(true)
    expect(formatBytes(44_000_000_000, false).startsWith("≥")).toBe(false)
    expect(formatBytes(44_000_000_000, true)).toContain("GB")
  })
})

describe("selectionWarnings", () => {
  const items = [
    item("/r/a", { reason: "dirty", dirty: 3, ignored: 2, ignoredExample: "node_modules/x.js" }),
    item("/r/b", { reason: "unpushed", unpushed: 2, detached: true }),
    item("/r/c", { reason: "unpushed", unpushed: 4, dirty: 1, ignored: 5, ignoredExample: "dist/y" }),
    item("/r/d", { reason: "scratch" }),
    item("/r/e", { reason: "dirty", dirty: 9, nested: ["sub"] }),
    item("/r/f", { reason: "dirty", dirty: 100 }),
  ]

  test("totals what a forced removal of the selected items loses", () => {
    const warnings = selectionWarnings(items, new Set(["/r/a", "/r/b", "/r/c", "/r/d"]))
    expect(warnings).toMatchObject({
      removable: ["/r/a", "/r/b", "/r/c", "/r/d"],
      dirty: 4,
      unpushed: 6,
      ignored: 7,
      ignoredExample: "node_modules/x.js",
      scratch: 1,
      rescued: 1,
      manual: [],
    })
  })

  test("keeps nested-repository items out of the removable set", () => {
    const warnings = selectionWarnings(items, new Set(["/r/a", "/r/e"]))
    expect(warnings.removable).toEqual(["/r/a"])
    expect(warnings.manual).toEqual(["/r/e"])
    expect(warnings.dirty).toBe(3)
  })

  test("ignores paths that are not selected or no longer listed", () => {
    expect(selectionWarnings(items, new Set(["/gone"])).removable).toEqual([])
  })
})

describe("selectable", () => {
  test("rejects error and nested items", () => {
    expect(selectable(item("/x"))).toBe(true)
    expect(selectable(item("/x", { reason: "error" }))).toBe(false)
    expect(selectable(item("/x", { nested: ["sub"] }))).toBe(false)
    expect(selectable(item("/x", { nested: [] }))).toBe(true)
  })
})
