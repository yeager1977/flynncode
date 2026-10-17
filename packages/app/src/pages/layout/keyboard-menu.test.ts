import { describe, expect, test } from "bun:test"
import { dispatchContextMenu } from "./keyboard-menu"

function fakeTarget(rect: { x: number; y: number; width: number; height: number }) {
  const dispatched: Event[] = []
  return {
    dispatched,
    target: {
      getBoundingClientRect: () => rect,
      dispatchEvent: (event: MouseEvent) => {
        dispatched.push(event)
        return true
      },
    } as unknown as HTMLElement,
  }
}

describe("dispatchContextMenu", () => {
  test("the ContextMenu key opens the menu at the trigger center", () => {
    const { target, dispatched } = fakeTarget({ x: 10, y: 20, width: 100, height: 30 })
    const event = new KeyboardEvent("keydown", { key: "ContextMenu", cancelable: true })

    expect(dispatchContextMenu(target, event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(dispatched).toHaveLength(1)
    const menu = dispatched[0] as MouseEvent
    expect(menu.type).toBe("contextmenu")
    expect(menu.clientX).toBe(60)
    expect(menu.clientY).toBe(35)
    expect(menu.bubbles).toBe(true)
  })

  test("Shift+F10 opens the menu too", () => {
    const { target, dispatched } = fakeTarget({ x: 0, y: 0, width: 40, height: 10 })
    const event = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, cancelable: true })

    expect(dispatchContextMenu(target, event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(dispatched).toHaveLength(1)
  })

  test("other keys do nothing and are not stopped", () => {
    for (const shiftKey of [false, true]) {
      const { target, dispatched } = fakeTarget({ x: 0, y: 0, width: 10, height: 10 })
      const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true })
      expect(dispatchContextMenu(target, enter)).toBe(false)
      expect(enter.defaultPrevented).toBe(false)
      expect(dispatched).toEqual([])

      const bareF10 = new KeyboardEvent("keydown", { key: "F10", shiftKey, cancelable: true })
      expect(dispatchContextMenu(target, bareF10)).toBe(shiftKey)
    }
  })
})