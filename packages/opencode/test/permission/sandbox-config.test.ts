import { test, expect } from "bun:test"
import { Schema } from "effect"
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

test("permission config accepts sandbox and approval keys", () => {
  const info = Schema.decodeUnknownSync(ConfigPermissionV1.Info)({ sandbox: "full-access", approval: "auto", bash: "ask" })
  expect(info).toEqual({ sandbox: "full-access", approval: "auto", bash: "ask" })
})

test("permission config rejects unknown sandbox", () => {
  expect(() => Schema.decodeUnknownSync(ConfigPermissionV1.Info)({ sandbox: "yolo" })).toThrow()
})

test("stripPolicyKeys keeps only tool rules", () => {
  expect(
    ConfigPermissionV1.stripPolicyKeys({ sandbox: "full-access", approval: "auto", bash: "full-access", edit: "allow" }),
  ).toEqual({ edit: "allow" })
})

test("misplacedPolicyKeys reports tool keys holding a policy literal", () => {
  // Known tool keys reject policy literals at decode; unknown tool keys only
  // pass through the widened rest record.
  expect(() => Schema.decodeUnknownSync(ConfigPermissionV1.Info)({ edit: "auto" })).toThrow()
  const info = Schema.decodeUnknownSync(ConfigPermissionV1.Info)({
    sandbox: "readonly",
    approval: "auto",
    archive: "auto",
    mcp_deploy: "full-access",
    read: { "*.env": "ask" },
    webfetch: "allow",
  })
  expect(ConfigPermissionV1.misplacedPolicyKeys(info)).toEqual(["archive", "mcp_deploy"])
  expect(ConfigPermissionV1.misplacedPolicyKeys(undefined)).toEqual([])
})
