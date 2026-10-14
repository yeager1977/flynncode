import { describe, expect, test } from "bun:test"
import { visibleSessionOrder } from "./new-layout-sidebar"

describe("visibleSessionOrder", () => {
  test("flattens expanded projects in order and skips collapsed ones", () => {
    expect(
      visibleSessionOrder([
        { expanded: true, sessions: ["a1", "a2"] },
        { expanded: false, sessions: ["b1"] },
        { expanded: true, sessions: ["c1"] },
      ]),
    ).toEqual(["a1", "a2", "c1"])
  })
  test("lists each expanded worktree's sessions after its project's main folder", () => {
    expect(
      visibleSessionOrder([
        {
          expanded: true,
          sessions: ["a1"],
          worktrees: [
            { expanded: true, sessions: ["a-wt1"] },
            { expanded: false, sessions: ["a-wt2"] },
            { expanded: true, sessions: ["a-wt3"] },
          ],
        },
        { expanded: false, sessions: ["b1"], worktrees: [{ expanded: true, sessions: ["b-wt1"] }] },
        { expanded: true, sessions: ["c1"] },
      ]),
    ).toEqual(["a1", "a-wt1", "a-wt3", "c1"])
  })
  test("empty when nothing is expanded", () => {
    expect(visibleSessionOrder([{ expanded: false, sessions: ["a"] }])).toEqual([])
  })
})
