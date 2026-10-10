import { describe, expect, test } from "bun:test"
import {
  BROWSER_SCREENSHOT_INLINE_LIMIT,
  browserAnnotation,
  inlineScreenshot,
  reversePatch,
  screenshotFallbackComment,
} from "./hunk-revert"

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

  test("browserAnnotation text omits the data url thumbnail", () => {
    const text = browserAnnotation({
      url: "http://127.0.0.1:3000/preview",
      path: "preview",
      note: "fix the nav overlap",
      x: 10,
      y: 20,
      width: 30,
      height: 15,
      thumbnail: "data:image/png;base64,AAAA",
    })
    expect(text).toBe("preview - fix the nav overlap - 10%,20%-40%,35%")
  })
})

describe("screenshot inline fallback", () => {
  test("bounds a long data url at the inline limit", () => {
    const long = `data:image/png;base64,${"A".repeat(BROWSER_SCREENSHOT_INLINE_LIMIT + 500)}`
    const bounded = inlineScreenshot(long)
    expect(bounded.length).toBe(BROWSER_SCREENSHOT_INLINE_LIMIT)
    // Short captures pass through unchanged.
    expect(inlineScreenshot("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA")
  })

  test("degrade composition appends the bounded capture to the comment", () => {
    const screenshot = `data:image/png;base64,${"A".repeat(BROWSER_SCREENSHOT_INLINE_LIMIT + 500)}`
    const degraded = screenshotFallbackComment("nav overlap", screenshot)
    expect(degraded.startsWith("nav overlap - data:image/png;base64,")).toBe(true)
    expect(degraded.length).toBe("nav overlap - ".length + BROWSER_SCREENSHOT_INLINE_LIMIT)
  })

  test("no capture leaves the comment untouched", () => {
    expect(screenshotFallbackComment("nav overlap", undefined)).toBe("nav overlap")
  })
})
