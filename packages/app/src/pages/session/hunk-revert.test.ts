import { describe, expect, test } from "bun:test"
import { browserAnnotation, reversePatch } from "./hunk-revert"

const patch = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 same
-old
+new
`

describe("reversePatch", () => {
  test("reverses a hunk without mentioning a chat message", () => {
    const reversed = reversePatch(patch)
    expect(reversed).toContain("--- b/src/a.ts")
    expect(reversed).toContain("+++ a/src/a.ts")
    expect(reversed).toContain("@@ -1,2 +1,2 @@")
    expect(reversed).toContain("-new")
    expect(reversed).toContain("+old")
    expect(reversed).not.toContain("message")
  })
})

describe("browserAnnotation", () => {
  test("records a click or region with the note", () => {
    expect(
      browserAnnotation({ url: "http://127.0.0.1:3000", note: "too wide", x: 10, y: 20, width: 0, height: 0 }),
    ).toBe("http://127.0.0.1:3000 10%,20%: too wide")
    expect(
      browserAnnotation({ url: "http://127.0.0.1:3000", note: "hero", x: 10, y: 20, width: 30, height: 15 }),
    ).toBe("http://127.0.0.1:3000 10%,20%-40%,35%: hero")
  })
})
