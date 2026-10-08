import { describe, expect, test } from "bun:test"
import {
  normalizeNewSessionWorktree,
  resolveNewSessionBranch,
  resolveNewSessionWorktree,
} from "./new-session-workspace-controller"

describe("disposable worktree selection", () => {
  test("keeps disposable selection distinct from main and create", () => {
    expect(normalizeNewSessionWorktree("disposable", "/project/feature", "/project")).toBe("disposable")
    expect(resolveNewSessionWorktree({ enabled: true, directory: "/project/feature", projectWorktree: "/project" })).toBe(
      "/project/feature",
    )
  })

  test("falls back to the local branch for disposable worktrees", () => {
    expect(
      resolveNewSessionBranch({ worktree: "disposable", local: "dev", worktreeBranch: () => "stale" }),
    ).toBe("dev")
  })
})
