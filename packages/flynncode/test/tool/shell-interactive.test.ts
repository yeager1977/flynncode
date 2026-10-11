import { describe, expect, test } from "bun:test"
import { needsInteractiveTerminal } from "../../src/tool/shell/prompt"

describe("needsInteractiveTerminal", () => {
  test("treats sudo, ssh, su, and passwd as interactive", () => {
    expect(needsInteractiveTerminal("sudo id", undefined)).toBe(true)
    expect(needsInteractiveTerminal("FOO=1 ssh host", undefined)).toBe(true)
    expect(needsInteractiveTerminal("  su -", undefined)).toBe(true)
    expect(needsInteractiveTerminal("passwd", undefined)).toBe(true)
  })

  test("does not treat ordinary commands as interactive", () => {
    expect(needsInteractiveTerminal("ls", undefined)).toBe(false)
    expect(needsInteractiveTerminal("git status", undefined)).toBe(false)
    expect(needsInteractiveTerminal("echo sudo", undefined)).toBe(false)
  })

  test("explicit flag wins over detection", () => {
    expect(needsInteractiveTerminal("ls", true)).toBe(true)
    expect(needsInteractiveTerminal("sudo id", false)).toBe(false)
  })
})
