import { describe, expect, test } from "bun:test"
import {
  addSessionFolder,
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
