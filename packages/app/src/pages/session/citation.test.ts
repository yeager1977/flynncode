import { describe, expect, test } from "bun:test"
import { citationFromTarget, citationFromText } from "./citation"

describe("citationFromText", () => {
  test("reads a path and line", () => {
    expect(citationFromText("see src/app.ts:12")).toEqual({ path: "src/app.ts", line: 12 })
    expect(citationFromText("packages/core/src/session.ts:40:8")).toEqual({
      path: "packages/core/src/session.ts",
      line: 40,
    })
    expect(citationFromText("src/index.ts:120")).toEqual({ path: "src/index.ts", line: 120 })
    expect(citationFromText("@src/index.ts")).toEqual({ path: "src/index.ts" })
  })

  test("ignores urls and plain words", () => {
    expect(citationFromText("https://example.com/a.ts:1")).toBeUndefined()
    expect(citationFromText("hello")).toBeUndefined()
    expect(citationFromText("bun.sh")).toBeUndefined()
  })

  test("skips external anchors with #L hashes", () => {
    const anchor = document.createElement("a")
    anchor.href = "https://github.com/x/y.ts#L3"
    expect(citationFromTarget(anchor)).toBeUndefined()
  })
})
