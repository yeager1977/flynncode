import { test, expect } from "bun:test"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"

test("resolveSessionPolicy defaults to workspace-write/manual", () => {
  const policy = ConfigPermissionV1.resolveSessionPolicy({})
  expect(policy).toEqual({ sandbox: "workspace-write", approval: "manual" })
})

test("resolveSessionPolicy reads explicit modes", () => {
  const policy = ConfigPermissionV1.resolveSessionPolicy({ sandbox: "readonly", approval: "auto" })
  expect(policy).toEqual({ sandbox: "readonly", approval: "auto" })
})

test("resolveSessionPolicy rejects unknown sandbox", () => {
  expect(() => ConfigPermissionV1.resolveSessionPolicy({ sandbox: "yolo" })).toThrow()
})

test("resolveSessionPolicy ignores tool rules when reading policy", () => {
  const policy = ConfigPermissionV1.resolveSessionPolicy({ sandbox: "readonly", bash: "ask" })
  expect(policy).toEqual({ sandbox: "readonly", approval: "manual" })
})
