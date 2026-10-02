import { describe, expect, test } from "bun:test"
import { hunkApply, reviewIndexActions, whenApplied } from "./hunk-apply"

describe("reviewIndexActions", () => {
  test("shows stage and unstage only for the unstaged git scope", () => {
    expect(reviewIndexActions("git")).toBe(true)
    expect(reviewIndexActions("branch")).toBe(false)
    expect(reviewIndexActions("turn")).toBe(false)
  })
})

describe("hunkApply", () => {
  test("revert reverses the patch and does not name a message revert", () => {
    const call = hunkApply({ patch: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n", revert: true })
    expect(call.patch).toContain("-new")
    expect(call.index).toBeUndefined()
    expect(JSON.stringify(call)).not.toContain("session.revert")
  })

  test("stage and unstage send the original patch and the index mode", () => {
    expect(hunkApply({ patch: "diff", index: "stage" })).toEqual({ patch: "diff", index: "stage" })
    expect(hunkApply({ patch: "diff", index: "unstage" })).toEqual({ patch: "diff", index: "unstage" })
  })
})

describe("whenApplied", () => {
  test("notifies only after apply resolves", async () => {
    let notified = false
    let resolveApply: (value: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      resolveApply = resolve
    })
    const settled = whenApplied(pending, () => {
      notified = true
    })
    expect(notified).toBe(false)
    resolveApply("ok")
    await settled
    expect(notified).toBe(true)
  })

  test("does not notify when apply rejects", async () => {
    let notified = false
    await expect(whenApplied(Promise.reject(new Error("not-clean")), () => {
      notified = true
    })).rejects.toThrow("not-clean")
    expect(notified).toBe(false)
  })
})
