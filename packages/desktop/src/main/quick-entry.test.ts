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

  test("unregisters on demand", () => {
    expect(source).toContain("globalShortcut.unregister")
  })
})
