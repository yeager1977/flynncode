import { test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

test("permission dock separates sandbox badge from approval actions", async () => {
  const source = await readFile(path.join(import.meta.dir, "session-permission-dock.tsx"), "utf8")
  expect(source).toContain("sandbox.badge.")
  expect(source).toContain("ui.permission.deny")
  expect(source).toContain("approval.mode.")
})

test("english dict carries sandbox and approval keys", async () => {
  const source = await readFile(path.join(import.meta.dir, "..", "..", "..", "i18n", "en.ts"), "utf8")
  expect(source).toContain("sandbox.badge.readonly")
  expect(source).toContain("approval.mode.auto")
  expect(source).toContain("approval.sandboxBlocked.title")
})

test("composer region passes live sandbox and approval mode into the dock", async () => {
  const source = await readFile(path.join(import.meta.dir, "session-composer-region.tsx"), "utf8")
  expect(source).toContain("permissionSandbox()")
  expect(source).toContain("permissionApprovalMode()")
  expect(source).toContain("setPermissionApprovalMode")
})
