import { describe, expect, test } from "bun:test"
import { createRoot, createSignal, mapArray } from "solid-js"
import type { Session } from "@flynncode/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { groupsByWorktree, type SidebarGroup } from "@/pages/layout/sidebar-sessions"

const session = (id: string, title: string) =>
  ({
    id,
    slug: id,
    projectID: "prj_1",
    directory: "/repo",
    title,
    version: "1",
    time: { created: 1, updated: 1 },
  }) as Session

describe("groupsByWorktree", () => {
  const group = (worktree: string, sessions: Session[]) =>
    ({ project: { worktree } as LocalProject, sessions }) satisfies SidebarGroup

  test("keeps every project section mounted when sessions update", () => {
    // <For> maps items with mapArray. Session events rebuild every group
    // object, so iterating the groups themselves re-created every section and
    // closed any open row context menu (archive, delete) before the click.
    createRoot((dispose) => {
      const [groups, setGroups] = createSignal([group("/a", [session("a1", "A")]), group("/b", [])])
      const sections = groupsByWorktree(groups)
      let mounted = 0
      const rows = mapArray(sections.worktrees, (worktree) => {
        mounted++
        return worktree
      })
      expect(rows()).toEqual(["/a", "/b"])
      expect(mounted).toBe(2)

      setGroups([group("/a", [session("a1", "A"), session("a2", "B")]), group("/b", [])])
      rows()
      expect(mounted).toBe(2)
      expect(sections.group("/a")?.sessions.map((item) => item.id)).toEqual(["a1", "a2"])

      setGroups([group("/a", []), group("/b", []), group("/c", [])])
      expect(rows()).toEqual(["/a", "/b", "/c"])
      expect(mounted).toBe(3)
      dispose()
    })
  })
})
