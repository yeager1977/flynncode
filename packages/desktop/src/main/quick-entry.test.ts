import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(join(import.meta.dir, "quick-entry.ts"), "utf8")

describe("quick-entry shortcut module", () => {
  test("exports register and unregister functions", () => {
    expect(source).toContain("export function registerQuickEntryShortcut")
    expect(source).toContain("export function unregisterQuickEntryShortcut")
  })

  test("uses the existing accelerator and sendQuickEntry", () => {
    expect(source).toContain("CommandOrControl+Shift+Space")
    expect(source).toContain("sendQuickEntry")
  })

  test("restores minimized windows and logs failed registration", () => {
    expect(source).toContain("win.restore()")
    expect(source).toContain("if (!registered)")
  })

  test("consults the settings toggle before registering", () => {
    expect(source).toContain("getQuickEntryEnabled")
    expect(source.indexOf("getQuickEntryEnabled")).toBeLessThan(source.indexOf("globalShortcut.register"))
  })

  test("unregisters on demand", () => {
    expect(source).toContain("globalShortcut.unregister")
  })
})
