import { describe, expect, test } from "bun:test"
import { permissionToggleTarget } from "./permission-toggle-target"

describe("permissionToggleTarget", () => {
  test("uses the session scope when a session exists", () => {
    expect(permissionToggleTarget("ses_123")).toBe("session")
  })

  test("uses the directory scope without a session", () => {
    expect(permissionToggleTarget(undefined)).toBe("directory")
  })

  test("uses the directory scope for an empty session id", () => {
    expect(permissionToggleTarget("")).toBe("directory")
  })
})
