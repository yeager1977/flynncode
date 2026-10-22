import { describe, expect, test } from "bun:test"
import { setTrayActive, shouldHideOnClose, trayActive } from "./tray-state"

describe("tray state", () => {
  test("reports whether the tray is active", () => {
    setTrayActive(false)
    expect(trayActive()).toBe(false)
    setTrayActive(true)
    expect(trayActive()).toBe(true)
    setTrayActive(false)
  })

  test("hides the window on close only while the tray can bring it back", () => {
    expect(shouldHideOnClose({ trayActive: true, quitting: false })).toBe(true)
    // Without a tray the app keeps quitting, so the window must not be hidden.
    expect(shouldHideOnClose({ trayActive: false, quitting: false })).toBe(false)
    // A real quit closes the window for good.
    expect(shouldHideOnClose({ trayActive: true, quitting: true })).toBe(false)
    expect(shouldHideOnClose({ trayActive: false, quitting: true })).toBe(false)
  })
})
