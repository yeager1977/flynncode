import { describe, expect, test } from "bun:test"
import path from "path"
import { isAttached, normalizeFolders, promoteToPrimary } from "@flynncode/core/project/folders"

describe("multifold helpers", () => {
  test("drops primary duplicates and preserves order", () => {
    expect(normalizeFolders("/repo", ["/a", "/repo", "/b", "/a"])).toEqual(["/a", "/b"])
  })
  test("normalizes lexically and skips relative extras", () => {
    expect(normalizeFolders("/repo/", ["/a/", "/x/../repo", "//b/./c", "rel", "/a"])).toEqual(["/a", "/b/c"])
    expect(normalizeFolders("/repo", ["/..", "/a/b/../../.."])).toEqual(["/"])
  })
  test("normalizes windows paths", () => {
    expect(normalizeFolders("C:\\repo", ["C:/repo/", "c:\\a\\.\\b\\..", "\\\\server\\share\\x\\"])).toEqual([
      "c:\\a",
      "\\\\server\\share\\x",
    ])
  })
  // folder-list is bundled into the desktop renderer, where node builtins are
  // stubbed as empty modules (path.resolve is undefined at runtime).
  test("folder-list stays free of node builtins", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../core/src/project/folder-list.ts"),
    ).text()
    expect(source).not.toMatch(/from\s+["'](node:)?(path|fs|os|url)["']/)
  })
  test("detects attachment", () => {
    expect(isAttached("/a/file.ts", "/repo", ["/a"])).toBe(true)
    expect(isAttached("/elsewhere/x", "/repo", ["/a"])).toBe(false)
  })
  test("promotes extra to primary", () => {
    expect(promoteToPrimary(["/repo", "/a", "/b"], "/b")).toEqual({ primary: "/b", extras: ["/repo", "/a"] })
  })
})
