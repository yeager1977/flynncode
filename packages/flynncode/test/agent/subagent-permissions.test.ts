import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@flynncode/core/v1/permission"
import { Permission } from "../../src/permission"
import { deriveSubagentSessionPermission, sandboxRules } from "../../src/agent/subagent-permissions"
import type { Agent } from "../../src/agent/agent"

const subagent = {
  name: "general",
  mode: "subagent",
  permission: Permission.fromConfig({}),
  options: {},
} satisfies Agent.Info

describe("sandboxRules", () => {
  test("restricted confines file access to the worktree directory", () => {
    expect(sandboxRules({ sandbox: "restricted", directory: "/w/a" })).toEqual([
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "/w/a/*", action: "allow" },
    ])
  })

  test("readonly confines file access to the worktree like restricted", () => {
    expect(sandboxRules({ sandbox: "readonly", directory: "/w/a" })).toEqual([
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "/w/a/*", action: "allow" },
    ])
  })

  test("readonly denies external reads outside the worktree while keeping allow-listed dirs reachable", () => {
    const agentPermission = Permission.fromConfig({
      external_directory: { "*": "ask", "/data/tool-output/*": "allow" },
    })
    const effective = Permission.merge(
      agentPermission,
      sandboxRules({ sandbox: "readonly", directory: "/w/a", agentPermission }),
    )
    expect(Permission.evaluate("external_directory", "/w/a/file.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("external_directory", "/etc/hosts", effective).action).toBe("deny")
    expect(Permission.evaluate("external_directory", "/data/tool-output/x", effective).action).toBe("allow")
  })

  test("unknown profiles degrade to no extra rules", () => {
    expect(sandboxRules({ sandbox: "open", directory: "/w/a" })).toEqual([])
    expect(sandboxRules({ sandbox: "", directory: "/w/a" })).toEqual([])
  })

  test("restricted denies paths outside the worktree while allowing inside", () => {
    const child = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent })
    const effective = Permission.merge(child, sandboxRules({ sandbox: "restricted", directory: "/w/a" }))
    expect(Permission.evaluate("external_directory", "/w/a/file.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("external_directory", "/w/other/file.ts", effective).action).toBe("deny")
  })

  test("restricted keeps the agent's Truncate/skill allow-list reachable", () => {
    const agentPermission = Permission.fromConfig({
      external_directory: { "*": "ask", "/data/tool-output/*": "allow", "/skills/*": "allow" },
    })
    const session = sandboxRules({ sandbox: "restricted", directory: "/w/a", agentPermission })
    // Runtime order: agent rules, then session rules (sandbox last).
    const effective = Permission.merge(agentPermission, session)
    expect(Permission.evaluate("external_directory", "/data/tool-output/x", effective).action).toBe("allow")
    expect(Permission.evaluate("external_directory", "/skills/review/SKILL.md", effective).action).toBe("allow")
    expect(Permission.evaluate("external_directory", "/w/a/file.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("external_directory", "/home/me/.ssh/id", effective).action).toBe("deny")
  })

  test("sandbox rules keep the ruleset type", () => {
    const rules: PermissionV1.Ruleset = sandboxRules({ sandbox: "restricted", directory: "/w/a" })
    expect(rules).toHaveLength(2)
  })
})
