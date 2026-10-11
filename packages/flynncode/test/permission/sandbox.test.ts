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

test("containment applies to writes only", () => {
  expect(Sandbox.containsWrite({ permission: "edit", toolID: "edit" })).toBe(true)
  for (const toolID of ["edit", "write", "apply_patch"]) {
    expect(Sandbox.containsWrite({ permission: "external_directory", toolID })).toBe(true)
  }
  for (const toolID of ["read", "glob", "grep", "list", "lsp", "skill", "bash"]) {
    expect(Sandbox.containsWrite({ permission: "external_directory", toolID })).toBe(false)
  }
  expect(Sandbox.containsWrite({ permission: "read", toolID: "read" })).toBe(false)
})

test("violation message names the blocked path and sandbox level", () => {
  const error = new Sandbox.SandboxViolationError({ path: "/etc/hosts", level: "workspace-write" })
  expect(error.message).toContain("/etc/hosts")
  expect(error.message).toContain("workspace-write")
})
