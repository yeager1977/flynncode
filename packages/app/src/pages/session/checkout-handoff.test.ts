import { describe, expect, test } from "bun:test"
import { checkoutHandoff } from "./checkout-handoff"

describe("checkoutHandoff", () => {
  test("stays on the primary checkout when the directory is not git", () => {
    expect(
      checkoutHandoff({
        current: "/repo",
        primary: "/repo",
        worktrees: [],
        git: false,
      }),
    ).toEqual({ ok: false, reason: "not-git" })
  })

  test("fails closed when the branch is already checked out elsewhere", () => {
    expect(
      checkoutHandoff({
        current: "/repo-wt",
        primary: "/repo",
        branch: "feature",
        worktrees: [
          { directory: "/repo-wt", branch: "feature" },
          { directory: "/other", branch: "feature" },
        ],
        git: true,
      }),
    ).toEqual({ ok: false, reason: "occupied" })
  })

  test("fails closed when the session branch is checked out in another worktree", () => {
    // The header call site only knows the session directory's branch; a
    // different worktree holding that branch must still block the handoff.
    expect(
      checkoutHandoff({
        current: "/repo-wt",
        primary: "/repo",
        branch: "feature",
        worktrees: [{ directory: "/other", branch: "feature" }, { directory: "/repo-wt" }],
        git: true,
      }),
    ).toEqual({ ok: false, reason: "occupied" })
  })

  test("moves back to the primary checkout from a session worktree", () => {
    expect(
      checkoutHandoff({
        current: "/repo-wt",
        primary: "/repo",
        worktrees: [{ directory: "/repo-wt", branch: "feature" }],
        git: true,
      }),
    ).toEqual({ ok: true, directory: "/repo", create: false })
  })
})
