import { describe, expect, test } from "bun:test"
import { adjacentIndex, adjacentProject, adjacentSession, adjacentUnseenSession } from "./sidebar-navigation"

const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]

describe("adjacentIndex", () => {
  test("wraps in both directions", () => {
    expect(adjacentIndex(3, 2, 1)).toBe(0)
    expect(adjacentIndex(3, 0, -1)).toBe(2)
    expect(adjacentIndex(3, 1, 1)).toBe(2)
  })

  test("starts at the first or last item when nothing is active", () => {
    expect(adjacentIndex(3, -1, 1)).toBe(0)
    expect(adjacentIndex(3, -1, -1)).toBe(2)
  })

  test("has nothing to move to in an empty list", () => {
    expect(adjacentIndex(0, -1, 1)).toBe(-1)
  })
})

describe("adjacentProject", () => {
  const projects = [{ worktree: "/a" }, { worktree: "/b" }, { worktree: "/c" }]

  test("moves relative to the active project", () => {
    expect(adjacentProject(projects, "/b", 1)?.worktree).toBe("/c")
    expect(adjacentProject(projects, "/a", -1)?.worktree).toBe("/c")
  })

  test("treats an unknown or missing project as nothing active", () => {
    expect(adjacentProject(projects, "/elsewhere", 1)?.worktree).toBe("/a")
    expect(adjacentProject(projects, undefined, -1)?.worktree).toBe("/c")
    expect(adjacentProject([], "/a", 1)).toBeUndefined()
  })
})

describe("adjacentSession", () => {
  test("returns the neighbour and its index", () => {
    expect(adjacentSession(sessions, "b", 1)).toEqual({ session: { id: "c" }, index: 2 })
    expect(adjacentSession(sessions, "a", -1)).toEqual({ session: { id: "d" }, index: 3 })
  })

  test("starts from the ends without a current session", () => {
    expect(adjacentSession(sessions, undefined, 1)?.session.id).toBe("a")
    expect(adjacentSession(sessions, undefined, -1)?.session.id).toBe("d")
    expect(adjacentSession([], "a", 1)).toBeUndefined()
  })
})

describe("adjacentUnseenSession", () => {
  const unseen = (ids: string[]) => (session: { id: string }) => ids.includes(session.id)

  test("skips seen sessions and wraps", () => {
    expect(adjacentUnseenSession(sessions, "c", 1, unseen(["a", "b"]))?.session.id).toBe("a")
    expect(adjacentUnseenSession(sessions, "b", -1, unseen(["c"]))?.session.id).toBe("c")
  })

  test("can land on the current session when it is the only unseen one", () => {
    expect(adjacentUnseenSession(sessions, "b", 1, unseen(["b"]))?.index).toBe(1)
  })

  test("starts from the ends without a current session", () => {
    expect(adjacentUnseenSession(sessions, undefined, 1, unseen(["a", "c"]))?.session.id).toBe("a")
    expect(adjacentUnseenSession(sessions, undefined, -1, unseen(["a", "c"]))?.session.id).toBe("c")
  })

  test("does nothing when every session is seen", () => {
    expect(adjacentUnseenSession(sessions, "a", 1, unseen([]))).toBeUndefined()
  })
})
