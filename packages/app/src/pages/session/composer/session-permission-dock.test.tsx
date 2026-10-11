import { test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

test("permission dock separates sandbox badge from approval actions", async () => {
  const source = await readFile(path.join(import.meta.dir, "session-permission-dock.tsx"), "utf8")
  expect(source).toContain("sandbox.badge.")
  expect(source).toContain("ui.permission.deny")
  expect(source).toContain("approval.mode.")
})

test("dock renders the deferred reviewer note for the reviewerApproved prop", async () => {
  const source = await readFile(path.join(import.meta.dir, "session-permission-dock.tsx"), "utf8")
  // Only defer verdicts reach the prompt, so the note speaks for the reviewer
  // deferring to the human — the old "auto-approved" key must not render.
  expect(source).toContain("approval.reviewerDeferred.note")
  expect(source).not.toContain("approval.reviewerApproved.note")
})

test("english dict carries sandbox and approval keys", async () => {
  const source = await readFile(path.join(import.meta.dir, "..", "..", "..", "i18n", "en.ts"), "utf8")
  expect(source).toContain("sandbox.badge.readonly")
  expect(source).toContain("approval.mode.auto")
  expect(source).toContain("approval.sandboxBlocked.title")
  expect(source).toContain("approval.reviewerDeferred.note")
})

test("composer region passes live sandbox and approval mode into the dock", async () => {
  const source = await readFile(path.join(import.meta.dir, "session-composer-region.tsx"), "utf8")
  expect(source).toContain("permissionSandbox()")
  expect(source).toContain("permissionApprovalMode()")
  expect(source).toContain("setPermissionApprovalMode")
  expect(source).toContain("permissionSandboxBlocked(")
  expect(source).toContain("blockedBySandbox")
})

test("composer region wires reviewerApproved from the defer verdict", async () => {
  const source = await readFile(path.join(import.meta.dir, "session-composer-region.tsx"), "utf8")
  expect(source).toContain('reviewerApproved={request.reviewer === "defer"}')
})
