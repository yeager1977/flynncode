import { test, expect } from "bun:test"
import { Permission } from "../../src/permission"
import { Reviewer } from "../../src/permission/reviewer"

const catchAll = [{ permission: "*", pattern: "*", action: "ask" as const }]

// Mirrors the built-in agent defaults: reads allowed, .env files prompt.
const defaults = Permission.fromConfig({
  "*": "allow",
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
})

test("reviewer allows read-only crossings", () => {
  expect(Reviewer.review({ permission: "read", patterns: ["src/a.ts"], ruleset: catchAll })).toBe("allow")
  expect(Reviewer.review({ permission: "glob", patterns: ["**/*.ts"], ruleset: catchAll })).toBe("allow")
  expect(Reviewer.review({ permission: "grep", patterns: ["TODO"], ruleset: [] })).toBe("allow")
})

test("reviewer defers mutations and shell", () => {
  expect(Reviewer.review({ permission: "edit", patterns: ["src/a.ts"], ruleset: [] })).toBe("defer")
  expect(Reviewer.review({ permission: "bash", patterns: ["npm run build"], ruleset: [] })).toBe("defer")
})

test("reviewer never allows archive or destructive shell", () => {
  expect(Reviewer.review({ permission: "archive", patterns: ["*"], ruleset: [] })).toBe("defer")
  expect(Reviewer.review({ permission: "bash", patterns: ["rm -rf /"], ruleset: [] })).toBe("defer")
})

test("reviewer keeps specific ask rules such as the default .env prompt", () => {
  expect(Reviewer.review({ permission: "read", patterns: ["/repo/.env"], ruleset: defaults })).toBe("defer")
  expect(Reviewer.review({ permission: "read", patterns: ["/repo/.env.local"], ruleset: defaults })).toBe("defer")
  expect(Reviewer.review({ permission: "read", patterns: ["/repo/.env.example"], ruleset: defaults })).toBe("allow")
  expect(Reviewer.review({ permission: "read", patterns: ["/repo/src/a.ts"], ruleset: defaults })).toBe("allow")
})

test("reviewer defers denied reads to the permission service", () => {
  const ruleset = Permission.fromConfig({ read: { "*": "allow", "secrets/*": "deny" } })
  expect(Reviewer.review({ permission: "read", patterns: ["secrets/key"], ruleset })).toBe("defer")
})

// tool/args ride along so the gate site can pass full context for richer
// static rules later; they must not change the AUTO_ALLOW behavior.
test("review receives tool and args for AUTO_ALLOW decisions", () => {
  expect(Reviewer.review({ permission: "read", patterns: ["*"], ruleset: catchAll, tool: "read", args: {} })).toBe(
    "allow",
  )
  expect(Reviewer.review({ permission: "edit", patterns: ["src/a.ts"], ruleset: [], tool: "edit", args: {} })).toBe(
    "defer",
  )
})
