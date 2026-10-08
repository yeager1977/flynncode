import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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

// Regression: submit used to reset the draft folders before creating the
// session, so the extras picked on the new-session page were dropped. The
// render path can't run under --conditions=solid, so pin the ordering and
// the create payload at the source level.
describe("new-session submit keeps draft folders", () => {
  const source = readFileSync(new URL("../../components/prompt-input/submit.ts", import.meta.url), "utf8")

  test("reads folders before resetting them", () => {
    const read = source.indexOf("input.newSessionExtraFolders?.()")
    const reset = source.indexOf("input.onNewSessionExtraFoldersReset?.()")
    expect(read).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(read)
  })

  test("sends extras and the chosen primary with session create", () => {
    expect(source).toContain(
      "additionalDirectories: extraFolders.filter((directory) => directory !== sessionDirectory)",
    )
    expect(source).toContain("if (primaryFolder) sessionDirectory = primaryFolder")
  })
})
