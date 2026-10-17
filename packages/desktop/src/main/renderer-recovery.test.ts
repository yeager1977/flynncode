import { describe, expect, test } from "bun:test"
import { rendererDeathAction } from "./renderer-recovery"

describe("renderer death action", () => {
  test("reloads in place for a killed or crashed renderer", () => {
    expect(rendererDeathAction({ reason: "killed", lastReloadAt: 0, now: 100_000 })).toBe("reload")
    expect(rendererDeathAction({ reason: "crashed", lastReloadAt: 0, now: 100_000 })).toBe("reload")
    expect(rendererDeathAction({ reason: "oom", lastReloadAt: 0, now: 100_000 })).toBe("reload")
  })

  test("shows the dialog for deaths a reload cannot fix", () => {
    expect(rendererDeathAction({ reason: "clean-exit", lastReloadAt: 0, now: 100_000 })).toBe("dialog")
    expect(rendererDeathAction({ reason: "launch-failed", lastReloadAt: 0, now: 100_000 })).toBe("dialog")
  })

  test("falls back to the dialog when the renderer dies again right after a reload", () => {
    expect(rendererDeathAction({ reason: "killed", lastReloadAt: 90_000, now: 100_000 })).toBe("dialog")
    expect(rendererDeathAction({ reason: "killed", lastReloadAt: 100_000, now: 100_001 })).toBe("dialog")
  })

  test("reloads again once the reload cooldown has passed", () => {
    expect(rendererDeathAction({ reason: "killed", lastReloadAt: 70_000, now: 100_000 })).toBe("reload")
  })
})