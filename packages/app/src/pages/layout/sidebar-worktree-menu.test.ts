import { describe, expect, test } from "bun:test"
import { worktreeMenuActions } from "./sidebar-workspace"
import { localHandoffAction } from "@/components/session/session-worktree-actions"

describe("sidebar worktree menu", () => {
  test("menu model exposes remove, reset, and handoff for sandbox entries", () => {
    const actions = worktreeMenuActions({ local: false, busy: false, occupied: false })
    expect(actions.map((action) => action.key)).toEqual([
      "session.worktree.remove",
      "session.worktree.reset",
      "session.worktree.handoff",
    ])
    expect(actions.every((action) => !action.disabled)).toBe(true)
  })

  test("disables sandbox actions while busy and handoff when occupied", () => {
    const busy = worktreeMenuActions({ local: false, busy: true, occupied: false })
    expect(busy.every((action) => action.disabled)).toBe(true)
    const occupied = worktreeMenuActions({ local: false, busy: false, occupied: true })
    expect(occupied.find((action) => action.key === "session.worktree.handoff")?.disabled).toBe(true)
    expect(occupied.find((action) => action.key === "session.worktree.handoff")?.disabledReason).toBe(
      "session.worktree.handoffOccupied",
    )
    expect(occupied.find((action) => action.key === "session.worktree.remove")?.disabled).toBe(false)
  })

  test("explains a disabled handoff without an open session or draft", () => {
    const actions = worktreeMenuActions({ local: false, busy: false, occupied: true, routed: false })
    const handoff = actions.find((action) => action.key === "session.worktree.handoff")
    expect(handoff?.disabled).toBe(true)
    expect(handoff?.disabledReason).toBe("session.worktree.handoffNoTab")
    expect(actions.find((action) => action.key === "session.worktree.remove")?.disabled).toBe(false)
  })

  test("offers handoff into the local workspace", () => {
    const actions = worktreeMenuActions({ local: true, busy: false, occupied: false })
    expect(actions.map((action) => action.key)).toEqual(["session.worktree.handoff"])
    expect(actions[0]?.disabled).toBe(false)
  })
})

describe("local handoff entry", () => {
  const usable = { allow: true, busy: false, occupied: false, routed: true } as const

  test("exists only when the rebind flag resolves true", () => {
    expect(localHandoffAction({ ...usable, allow: false })).toBeUndefined()
    expect(localHandoffAction({ ...usable, allow: true })).toEqual({
      key: "session.worktree.handoffLocal",
      disabled: false,
    })
  })

  test("explains the disabled entry with the guard reasons", () => {
    const busy = localHandoffAction({ ...usable, busy: true })
    expect(busy?.disabled).toBe(true)

    const occupied = localHandoffAction({ ...usable, occupied: true })
    expect(occupied?.disabled).toBe(true)
    expect(occupied?.disabledReason).toBe("session.worktree.handoffOccupied")

    const noRoute = localHandoffAction({ ...usable, routed: false })
    expect(noRoute?.disabled).toBe(true)
    expect(noRoute?.disabledReason).toBe("session.worktree.handoffNoTab")

    // A routed session already on the Local checkout is a self-handoff.
    const localRouted = localHandoffAction({ ...usable, localRouted: true })
    expect(localRouted?.disabled).toBe(true)
    expect(localRouted?.disabledReason).toBeUndefined()
  })
})
