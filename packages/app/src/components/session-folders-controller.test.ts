import { describe, expect, test } from "bun:test"
import {
  addSessionFolder,
  appendSessionFolders,
  MaxSessionExtraFolders,
  normalizeSessionFolders,
  promoteSessionFolder,
  removeSessionFolder,
} from "@/components/session-folders"

describe("sidebar folders model", () => {
  test("primary badge stays on index 0", () => {
    expect(normalizeSessionFolders("/repo", [])).toEqual([])
  })
  test("add dedupes attached folders", () => {
    expect(addSessionFolder("/repo", ["/docs"], "/docs")).toEqual(["/docs"])
    expect(addSessionFolder("/repo", ["/docs"], "/repo")).toEqual(["/docs"])
  })
  test("set-primary demotes old primary to extras head", () => {
    expect(promoteSessionFolder("/repo", ["/docs", "/lib"], "/lib")).toEqual({
      primary: "/lib",
      extras: ["/repo", "/docs"],
    })
  })
  test("remove filters extras", () => {
    expect(removeSessionFolder(["/docs"], "/missing")).toEqual(["/docs"])
  })
})

describe("open-session folder append plan", () => {
  test("appends fresh picks after existing extras", () => {
    expect(appendSessionFolders("/repo", ["/docs"], ["/lib", "/web"])).toEqual({
      extras: ["/docs", "/lib", "/web"],
      added: 2,
      duplicate: false,
      overLimit: false,
    })
  })
  test("drops the primary, attached, and repeated picks and reports duplicates", () => {
    expect(appendSessionFolders("/repo", ["/docs"], ["/repo", "/docs", "/lib", "/lib"])).toEqual({
      extras: ["/docs", "/lib"],
      added: 1,
      duplicate: true,
      overLimit: false,
    })
  })
  test("flags a batch that would exceed the extras limit", () => {
    const extras = Array.from({ length: MaxSessionExtraFolders }, (_, index) => `/extra-${index}`)
    expect(appendSessionFolders("/repo", extras, ["/one-more"]).overLimit).toBe(true)
    expect(appendSessionFolders("/repo", extras.slice(1), ["/one-more"]).overLimit).toBe(false)
  })
})
