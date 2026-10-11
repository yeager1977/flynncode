import { describe, expect, test } from "bun:test"
import { ComputerUse } from "../../src/config/computer-use"

describe("resolveComputerUse", () => {
  test("defaults to disabled with empty allowlist", () => {
    expect(ComputerUse.resolveComputerUse({})).toEqual({
      enabled: false,
      allowedApps: [],
      tiers: { observe: true, mutate: true },
    })
    expect(ComputerUse.resolveComputerUse(undefined)).toEqual({
      enabled: false,
      allowedApps: [],
      tiers: { observe: true, mutate: true },
    })
  })

  test("reads explicit enabled plus allowlist", () => {
    expect(ComputerUse.resolveComputerUse({ enabled: true, allowedApps: ["com.example.gui"] })).toEqual({
      enabled: true,
      allowedApps: ["com.example.gui"],
      tiers: { observe: true, mutate: true },
    })
  })

  test("rejects non-boolean enabled", () => {
    expect(() => ComputerUse.resolveComputerUse({ enabled: "yes" })).toThrow()
  })

  test("the reserved pane app id is the only built-in surface id", () => {
    expect(ComputerUse.ReservedPaneAppID).toBe("flynncode:browser-pane")
  })
})

describe("isAppAllowed", () => {
  test("exact match only", () => {
    expect(ComputerUse.isAppAllowed("com.example.gui", ["com.example.gui"])).toBe(true)
    expect(ComputerUse.isAppAllowed("com.example.GUI", ["com.example.gui"])).toBe(false)
    expect(ComputerUse.isAppAllowed("com.example.gui", [])).toBe(false)
  })
})
