import { describe, expect, test } from "bun:test"
import { clampPanePoint, isComputerUseTargetAllowed } from "./computer-use"

describe("clampPanePoint", () => {
  test("clamps outside points inside the pane", () => {
    expect(clampPanePoint(-5, 900, { width: 800, height: 600 })).toEqual({ x: 0, y: 600 })
  })

  test("keeps inside points unchanged", () => {
    expect(clampPanePoint(100, 120, { width: 800, height: 600 })).toEqual({ x: 100, y: 120 })
  })
})

describe("isComputerUseTargetAllowed", () => {
  test("exact allowlist match only", () => {
    expect(isComputerUseTargetAllowed("com.example.gui", ["com.example.gui"])).toBe(true)
    expect(isComputerUseTargetAllowed("other", ["com.example.gui"])).toBe(false)
    expect(isComputerUseTargetAllowed("com.example.gui", [])).toBe(false)
  })
})
