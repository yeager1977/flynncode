import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createNeighbourWarmup, NEIGHBOUR_PREFETCH_MESSAGES } from "@/pages/layout/sidebar-prefetch"

const list = (...ids: string[]) => ids.map((id) => ({ id }))

function mount(initial: { id: string }[], routed?: string) {
  const [sessions, setSessions] = createSignal(initial)
  const [sessionID, setSessionID] = createSignal(routed)
  const [enabled, setEnabled] = createSignal(true)
  const warmed: string[] = []
  const dispose = createRoot((dispose) => {
    createNeighbourWarmup({ enabled, sessionID, sessions, warm: (session) => warmed.push(session.id) })
    return dispose
  })
  return { warmed, setSessions, setSessionID, setEnabled, dispose }
}

describe("neighbour warm-up", () => {
  test("prefetches a small first page", () => {
    expect(NEIGHBOUR_PREFETCH_MESSAGES).toBe(20)
  })

  test("warms only the direct neighbours of the routed session", () => {
    const view = mount(list("a", "b", "c", "d", "e"), "c")
    expect(view.warmed).toEqual(["d", "b"])
    view.dispose()
  })

  test("does not warm again when the session list re-sorts", () => {
    const view = mount(list("a", "b", "c", "d", "e"), "c")
    view.warmed.length = 0

    view.setSessions(list("c", "a", "b", "d", "e"))
    view.setSessions(list("e", "d", "c", "b", "a"))

    expect(view.warmed).toEqual([])
    view.dispose()
  })

  test("warms again when the routed session changes", () => {
    const view = mount(list("a", "b", "c", "d"), "b")
    view.warmed.length = 0

    view.setSessionID("d")

    expect(view.warmed).toEqual(["c"])
    view.dispose()
  })

  test("does not warm anything without a routed session", () => {
    const view = mount(list("a", "b", "c"))
    view.setSessions(list("b", "a", "c"))
    expect(view.warmed).toEqual([])
    view.dispose()
  })

  test("waits for the routed session to appear in the list", () => {
    const view = mount(list("a", "b"), "x")
    expect(view.warmed).toEqual([])

    view.setSessions(list("a", "x", "b"))
    view.setSessions(list("x", "a", "b"))

    expect(view.warmed).toEqual(["b", "a"])
    view.dispose()
  })

  test("stays idle while disabled", () => {
    const view = mount(list("a", "b", "c"), "b")
    view.warmed.length = 0
    view.setEnabled(false)
    view.setSessionID("c")
    expect(view.warmed).toEqual([])
    view.dispose()
  })
})
