import { describe, expect, test } from "bun:test"
import {
  addSessionFolder,
  normalizeSessionFolders,
  promoteSessionFolder,
  removeSessionFolder,
} from "@/pages/new-session/new-session-workspace-controller"

describe("new-session folders model", () => {
  test("first folder is primary", () => {
    expect(normalizeSessionFolders("/repo", ["/repo", "/docs"])).toEqual(["/docs"])
  })
  test("extras cap at 8", () => {
    const extras = Array.from({ length: 8 }, (_, index) => `/extra-${index}`)
    expect(addSessionFolder("/repo", extras, "/one-more")).toEqual(extras)
  })
  test("promote swaps primary", () => {
    expect(promoteSessionFolder("/repo", ["/docs"], "/docs")).toEqual({ primary: "/docs", extras: ["/repo"] })
  })
  test("remove drops folder", () => {
    expect(removeSessionFolder(["/docs", "/lib"], "/docs")).toEqual(["/lib"])
  })
})
