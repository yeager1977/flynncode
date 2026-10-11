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

  test("accepts sandbox mode values alongside named profiles", () => {
    for (const sandbox of ["readonly", "workspace-write", "full-access"]) {
      const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ sandbox })
      expect(decoded.sandbox).toBe(sandbox)
    }
  })

  test("keeps unknown sandbox values instead of failing config load", () => {
    const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ sandbox: "bogus-profile" })
    expect(decoded.sandbox).toBe("bogus-profile")
  })
})
