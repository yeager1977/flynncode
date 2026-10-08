import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigAgentV1 } from "../src/v1/config/agent"

describe("agent isolation config", () => {
  test("accepts isolation and sandbox overrides", () => {
    const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ isolation: "worktree", sandbox: "restricted" })
    expect(decoded.isolation).toBe("worktree")
    expect(decoded.sandbox).toBe("restricted")
  })

  test("degrades unknown isolation to undefined", () => {
    const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ isolation: "cloud-vm" })
    expect(decoded.isolation).toBeUndefined()
  })
})
