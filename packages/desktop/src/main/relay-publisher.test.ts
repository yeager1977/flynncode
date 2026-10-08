import { expect, test } from "bun:test"
import { buildDigestBody } from "./relay-publisher.ts"

test("digest body carries metadata only", () => {
  const body = buildDigestBody({
    originID: "laptop",
    items: [{ sessionID: "ses_1", directory: "/repo", title: "Fix", kind: "permission", updated: 5 }],
    updatedAt: 7,
  })
  expect(body).toEqual({ originID: "laptop", items: [{ sessionID: "ses_1", directory: "/repo", title: "Fix", kind: "permission", updated: 5 }], updatedAt: 7 })
})
