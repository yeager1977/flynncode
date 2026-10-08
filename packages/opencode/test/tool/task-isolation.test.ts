import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Parameters } from "../../src/tool/task"

describe("task isolation params", () => {
  test("defaults to inherit and retain", () => {
    const decoded = Schema.decodeUnknownSync(Parameters)({
      description: "scan repo",
      prompt: "find dead code",
      subagent_type: "explore",
    })
    expect(decoded.isolation ?? "inherit").toBe("inherit")
    expect(decoded.cleanup ?? "retain").toBe("retain")
  })

  test("accepts worktree isolation with dispose cleanup", () => {
    const decoded = Schema.decodeUnknownSync(Parameters)({
      description: "scan repo",
      prompt: "find dead code",
      subagent_type: "explore",
      isolation: "worktree",
      cleanup: "dispose",
    })
    expect(decoded.isolation).toBe("worktree")
    expect(decoded.cleanup).toBe("dispose")
  })
})
