import { test, expect } from "bun:test"
import { Sandbox } from "../../src/permission/sandbox"

test("workspace-write allows worktree paths, denies outside", () => {
  expect(Sandbox.isPathAllowed("/repo/src/a.ts", "/repo", [], "workspace-write")).toBe(true)
  expect(Sandbox.isPathAllowed("/etc/passwd", "/repo", [], "workspace-write")).toBe(false)
})

test("workspace-write resolves relative paths against the root, not the cwd", () => {
  expect(Sandbox.isPathAllowed("src/a.ts", "/repo", [], "workspace-write")).toBe(true)
  expect(Sandbox.isPathAllowed("../other/a.ts", "/repo", [], "workspace-write")).toBe(false)
})

test("workspace-write allows registered sandbox dirs", () => {
  expect(Sandbox.isPathAllowed("/tmp/wt-1/f.ts", "/repo", ["/tmp/wt-1"], "workspace-write")).toBe(true)
})

test("readonly denies writes everywhere", () => {
  expect(Sandbox.isPathAllowed("/repo/src/a.ts", "/repo", [], "readonly")).toBe(false)
})

test("full-access allows everything", () => {
  expect(Sandbox.isPathAllowed("/etc/passwd", "/repo", [], "full-access")).toBe(true)
})

test("resolveLevel defaults to workspace-write", () => {
  expect(Sandbox.resolveLevel(undefined)).toBe("workspace-write")
})
