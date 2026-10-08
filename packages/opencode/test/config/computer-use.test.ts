import { describe, expect, test } from "bun:test"
import { ComputerUse } from "../../src/config/computer-use"

describe("resolveComputerUse", () => {
  test("defaults to disabled with empty allowlist", () => {
    expect(ComputerUse.resolveComputerUse({})).toEqual({ enabled: false, allowedApps: [] })
    expect(ComputerUse.resolveComputerUse(undefined)).toEqual({ enabled: false, allowedApps: [] })
  })

  test("reads explicit enabled plus allowlist", () => {
    expect(ComputerUse.resolveComputerUse({ enabled: true, allowedApps: ["com.example.gui"] })).toEqual({
      enabled: true,
      allowedApps: ["com.example.gui"],
    })
  })

  test("rejects non-boolean enabled", () => {
    expect(() => ComputerUse.resolveComputerUse({ enabled: "yes" })).toThrow()
  })
})

describe("isAppAllowed", () => {
  test("exact match only", () => {
    expect(ComputerUse.isAppAllowed("com.example.gui", ["com.example.gui"])).toBe(true)
    expect(ComputerUse.isAppAllowed("com.example.GUI", ["com.example.gui"])).toBe(false)
    expect(ComputerUse.isAppAllowed("com.example.gui", [])).toBe(false)
  })
})
