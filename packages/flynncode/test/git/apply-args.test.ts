import { describe, expect, test } from "bun:test"
import { applyArgs } from "../../src/git/apply-args"

describe("applyArgs", () => {
  test("maps omitted and worktree to plain apply", () => {
    expect(applyArgs()).toEqual(["apply", "-"])
    expect(applyArgs("worktree")).toEqual(["apply", "-"])
  })

  test("maps stage and unstage to cached apply", () => {
    expect(applyArgs("stage")).toEqual(["apply", "--cached", "-"])
    expect(applyArgs("unstage")).toEqual(["apply", "--cached", "-R", "-"])
  })
})
