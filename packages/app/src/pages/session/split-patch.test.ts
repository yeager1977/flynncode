import { describe, expect, test } from "bun:test"
import { splitPatchToHunks } from "./split-patch"

const patch = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old-one",
  "+new-one",
  " context",
  "@@ -10,2 +10,2 @@",
  "-old-two",
  "+new-two",
  " context",
].join("\n")

describe("splitPatchToHunks", () => {
  test("splits one patch into one self-contained patch per hunk", () => {
    const hunks = splitPatchToHunks(patch)
    expect(hunks.length).toBe(2)
    expect(hunks[0]).toContain("--- a/src/a.ts")
    expect(hunks[0]).toContain("@@ -1,2 +1,2 @@")
    expect(hunks[0]).toContain("+new-one")
    expect(hunks[0]).not.toContain("+new-two")
    expect(hunks[1]).toContain("@@ -10,2 +10,2 @@")
    expect(hunks[1]).toContain("+new-two")
  })

  test("returns the whole patch when there is a single hunk", () => {
    const single = splitPatchToHunks(hunksSingle())
    expect(single.length).toBe(1)
  })

  test("returns an empty array for a patch without hunks", () => {
    expect(splitPatchToHunks("--- a/x\n+++ b/x\n")).toEqual([])
  })
})

function hunksSingle() {
  return ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n")
}
