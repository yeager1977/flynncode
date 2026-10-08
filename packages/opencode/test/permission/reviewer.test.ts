import { test, expect } from "bun:test"
import { Reviewer } from "../../src/permission/reviewer"

test("reviewer allows read-only crossings", () => {
  expect(Reviewer.review({ permission: "read", patterns: ["src/a.ts"] })).toBe("allow")
  expect(Reviewer.review({ permission: "glob", patterns: ["**/*.ts"] })).toBe("allow")
  expect(Reviewer.review({ permission: "grep", patterns: ["TODO"] })).toBe("allow")
})

test("reviewer defers mutations and shell", () => {
  expect(Reviewer.review({ permission: "edit", patterns: ["src/a.ts"] })).toBe("defer")
  expect(Reviewer.review({ permission: "bash", patterns: ["npm run build"] })).toBe("defer")
})

test("reviewer never allows archive or destructive shell", () => {
  expect(Reviewer.review({ permission: "archive", patterns: ["*"] })).toBe("defer")
  expect(Reviewer.review({ permission: "bash", patterns: ["rm -rf /"] })).toBe("defer")
})
