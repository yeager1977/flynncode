import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./review-panel-v2.tsx", import.meta.url), "utf8")

describe("review panel v2 preview markup", () => {
  test("keeps the preview note as a JSX comment, not rendered text", () => {
    expect(source).toContain("{/* Key on the file path")
    expect(source).not.toMatch(/^\s*\/\/ Key on the file path/m)
  })
})
