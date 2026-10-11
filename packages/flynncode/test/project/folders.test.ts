import { describe, expect, test } from "bun:test"
import { isAttached, normalizeFolders, promoteToPrimary } from "@flynncode/core/project/folders"

describe("multifold helpers", () => {
  test("drops primary duplicates and preserves order", () => {
    expect(normalizeFolders("/repo", ["/a", "/repo", "/b", "/a"])).toEqual(["/a", "/b"])
  })
  test("detects attachment", () => {
    expect(isAttached("/a/file.ts", "/repo", ["/a"])).toBe(true)
    expect(isAttached("/elsewhere/x", "/repo", ["/a"])).toBe(false)
  })
  test("promotes extra to primary", () => {
    expect(promoteToPrimary(["/repo", "/a", "/b"], "/b")).toEqual({ primary: "/b", extras: ["/repo", "/a"] })
  })
})
