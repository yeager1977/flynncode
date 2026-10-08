import { describe, expect, test } from "bun:test"
import { groupInbox } from "../src/inbox.ts"

describe("groupInbox", () => {
  test("marks permission and question kinds separately", () => {
    const items = groupInbox({
      sessions: [{ id: "ses_1", title: "Fix login", directory: "/repo/app", updated: 100 }],
      permissions: [{ sessionID: "ses_1", id: "perm_1" }],
      questions: [],
    })
    expect(items).toEqual([
      { sessionID: "ses_1", directory: "/repo/app", title: "Fix login", kind: "permission", updated: 100 },
    ])
  })
})
