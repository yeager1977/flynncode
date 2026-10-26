import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

describe("Permission.restrict", () => {
  const ruleset = Permission.fromConfig({
    "*": "allow",
    read: { "*": "allow", "*.env": "ask" },
    edit: { "src/*": "ask", "*.x": "ask" },
    "*_delete": "ask",
  })

  test("denies everything outside the scopes and keeps the standing action inside", () => {
    const restricted = Permission.restrict(ruleset, [
      { permission: "read", pattern: "*" },
      { permission: "edit", pattern: "*.ipynb" },
      { permission: "github_*", pattern: "*" },
    ])
    expect(Permission.evaluate("read", "a.ts", restricted).action).toBe("allow")
    expect(Permission.evaluate("read", "x/.env", restricted).action).toBe("ask")
    expect(Permission.evaluate("bash", "ls", restricted).action).toBe("deny")
    expect(Permission.evaluate("edit", "a.ts", restricted).action).toBe("deny")
    expect(Permission.evaluate("edit", "notes.ipynb", restricted).action).toBe("allow")
    expect(Permission.evaluate("github_get_issue", "*", restricted).action).toBe("allow")
    expect(Permission.evaluate("slack_send", "*", restricted).action).toBe("deny")
  })

  test("an overlap it cannot express as a glob only ever restricts", () => {
    const restricted = Permission.restrict(ruleset, [
      { permission: "edit", pattern: "*.ipynb" },
      { permission: "github_*", pattern: "*" },
    ])
    // `src/*` ∩ `*.ipynb` and `*_delete` ∩ `github_*` are not plain globs:
    // the asks become denies instead of leaking an allow.
    expect(Permission.evaluate("edit", "src/a.ipynb", restricted).action).toBe("deny")
    expect(Permission.evaluate("edit", "lab.ipynb", restricted).action).toBe("allow")
    expect(Permission.evaluate("github_delete", "*", restricted).action).toBe("deny")
    expect(Permission.evaluate("other_delete", "*", restricted).action).toBe("deny")
  })
})
