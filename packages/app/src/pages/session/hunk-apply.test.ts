import { describe, expect, test } from "bun:test"
import { applyHunkSequence, hunkApply, reviewIndexActions, whenApplied } from "./hunk-apply"
import { splitPatchToHunks } from "./split-patch"

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

describe("per-hunk apply wiring", () => {
  test("each split hunk round-trips through hunkApply without a message revert", () => {
    const patch = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "@@ -10 +10 @@",
      "-c",
      "+d",
    ].join("\n")
    const hunks = splitPatchToHunks(patch)
    expect(hunks.length).toBe(2)
    for (const hunk of hunks) {
      const call = hunkApply({ patch: hunk, index: "stage" })
      expect(call).toEqual({ patch: hunk, index: "stage" })
      expect(JSON.stringify(call)).not.toContain("session.revert")
    }
  })
})

describe("applyHunkSequence", () => {
  test("stages then reverts two hunks of one file in order without overlapping applies", async () => {
    const hunks = splitPatchToHunks(
      ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-a", "+b", "@@ -10 +10 @@", "-c", "+d"].join("\n"),
    )
    expect(hunks.length).toBe(2)
    const calls = [
      hunkApply({ patch: hunks[0] ?? "", index: "stage" }),
      hunkApply({ patch: hunks[1] ?? "", revert: true }),
    ]
    const started: string[] = []
    const finished: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let applyCount = 0
    const pending = applyHunkSequence(calls, async (call) => {
      applyCount += 1
      started.push(call.patch)
      if (applyCount === 1) await firstGate
      finished.push(call.patch)
    })
    // The first apply is gated: a parallel implementation would already have
    // started the second apply by now.
    expect(started).toHaveLength(1)
    releaseFirst()
    await pending
    expect(started).toEqual([calls[0]?.patch, calls[1]?.patch])
    expect(finished).toEqual([calls[0]?.patch, calls[1]?.patch])
    expect(calls[0]).toEqual({ patch: hunks[0], index: "stage" })
    expect(calls[1]?.patch).toContain("-d")
    expect(calls[1]).not.toHaveProperty("index")
  })
})
