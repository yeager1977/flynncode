import { describe, expect, test } from "bun:test"
import { pendingCount, statusOf, trustRows } from "./hooks-payload"

describe("statusOf", () => {
  test("managed wins over trusted", () => {
    expect(statusOf({ trusted: true, managed: true })).toBe("managed")
    expect(statusOf({ trusted: true, managed: false })).toBe("trusted")
    expect(statusOf({ trusted: false, managed: false })).toBe("pending")
  })
})

describe("trustRows", () => {
  test("maps entries to rows preserving order", () => {
    expect(
      trustRows([
        { hash: "a", event: "PreToolUse", matcher: "", summary: "check.sh", trusted: false, managed: false },
        { hash: "b", event: "Stop", matcher: "", summary: "s/t", trusted: true, managed: true },
      ]),
    ).toEqual([
      { hash: "a", event: "PreToolUse", matcher: "", summary: "check.sh", status: "pending" },
      { hash: "b", event: "Stop", matcher: "", summary: "s/t", status: "managed" },
    ])
  })

  test("counts pending rows", () => {
    expect(
      pendingCount([
        { hash: "a", event: "e", matcher: "", summary: "s", status: "pending" },
        { hash: "b", event: "e", matcher: "", summary: "s", status: "trusted" },
      ]),
    ).toBe(1)
  })
})
