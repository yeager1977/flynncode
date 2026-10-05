import { describe, expect, test } from "bun:test"
import { worktreeFromConfig, worktreeHasConfig, worktreeKeepValue, worktreeToConfig, worktreeValidationErrors } from "./worktree-payload"

describe("worktree-payload", () => {
  test("reads an absent object as empty fields", () => {
    expect(worktreeFromConfig({})).toEqual({ location: "", branchPrefix: "", keep: "" })
    expect(worktreeHasConfig({})).toBe(false)
  })

  test("round-trips configured values", () => {
    const config = { worktree: { location: ".wt", branch_prefix: "feat", keep: 5 } } as never
    const form = worktreeFromConfig(config)
    expect(form).toEqual({ location: ".wt", branchPrefix: "feat", keep: "5" })
    expect(worktreeToConfig(form)).toEqual({ worktree: { location: ".wt", branch_prefix: "feat", keep: 5 } })
    expect(worktreeHasConfig(config)).toBe(true)
  })

  test("empty fields stay absent so a save does not write blank keys", () => {
    expect(worktreeToConfig({ location: "  ", branchPrefix: "", keep: "" })).toEqual({})
    expect(worktreeToConfig({ location: ".wt", branchPrefix: "", keep: "" })).toEqual({
      worktree: { location: ".wt" },
    })
  })

  test("keep parses whole non-negative numbers only", () => {
    expect(worktreeKeepValue({ location: "", branchPrefix: "", keep: "3" })).toBe(3)
    expect(worktreeKeepValue({ location: "", branchPrefix: "", keep: "3.5" })).toBeUndefined()
    expect(worktreeKeepValue({ location: "", branchPrefix: "", keep: "-1" })).toBeUndefined()
    expect(worktreeKeepValue({ location: "", branchPrefix: "", keep: "abc" })).toBeUndefined()
  })

  test("validation flags a bad keep count and a home-relative location", () => {
    expect(worktreeValidationErrors({ location: ".wt", branchPrefix: "", keep: "10" })).toEqual([])
    expect(worktreeValidationErrors({ location: "", branchPrefix: "", keep: "ten" })).toEqual(["keep"])
    expect(worktreeValidationErrors({ location: "~/wt", branchPrefix: "", keep: "" })).toEqual(["location"])
  })
})