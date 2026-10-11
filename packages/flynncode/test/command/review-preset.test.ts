import { describe, expect, test } from "bun:test"
import { reviewPresetArgs } from "../../src/command/review-preset"

describe("reviewPresetArgs", () => {
  test("uncommitted preset yields empty args for the default review", () => {
    expect(reviewPresetArgs("uncommitted")).toBe("")
  })

  test("base-branch preset targets the branch diff", () => {
    expect(reviewPresetArgs("base-branch", "dev")).toBe("dev")
  })

  test("commit preset targets the exact sha", () => {
    expect(reviewPresetArgs("commit", "abc1234")).toBe("abc1234")
  })

  test("missing target falls back to uncommitted", () => {
    expect(reviewPresetArgs("base-branch")).toBe("")
    expect(reviewPresetArgs("commit")).toBe("")
  })

  test("whitespace target is treated as empty", () => {
    expect(reviewPresetArgs("base-branch", "  ")).toBe("")
  })
})
