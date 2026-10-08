import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("SessionSidePanel history", () => {
  test("mounts history panel beside changed files", () => {
    const source = readFileSync(new URL("./session-side-panel.tsx", import.meta.url), "utf8")
    expect(source).toContain("SessionHistoryPanel")
    expect(source).toContain("FileTree")
  })
})
