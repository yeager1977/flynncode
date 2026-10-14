import { describe, expect, test } from "bun:test"
import type { Session } from "@flynncode/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { groupByProject } from "./sidebar-sessions"

const session = (id: string, directory: string, updated: number) =>
  ({ id, directory, title: id, time: { created: updated, updated } }) as Session

describe("groupByProject", () => {
  test("lists each project's main and worktree sessions newest first, in project order", () => {
    const projects = [
      { worktree: "/b", expanded: true },
      { worktree: "/a", expanded: true, sandboxes: ["/a-wt"] },
    ] as LocalProject[]
    const groups = groupByProject(projects, [
      session("a1", "/a", 1),
      session("b1", "/b", 2),
      session("wt", "/a-wt", 3),
      session("x", "/elsewhere", 4),
    ])
    expect(groups.map((group) => [group.project.worktree, group.sessions.map((item) => item.id)])).toEqual([
      ["/b", ["b1"]],
      ["/a", ["wt", "a1"]],
    ])
  })

  test("keeps projects without sessions", () => {
    expect(groupByProject([{ worktree: "/a", expanded: true }] as LocalProject[], [])).toEqual([
      { project: { worktree: "/a", expanded: true } as LocalProject, sessions: [] },
    ])
  })
})
