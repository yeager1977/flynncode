import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(join(import.meta.dir, "quick-entry.tsx"), "utf8")

describe("quick-entry overlay", () => {
  test("offers a screenshot attach control behind the desktop capture capability", () => {
    expect(source).toContain('data-action="quick-entry-attach"')
    expect(source).toContain("platform.screenshot")
  })

  test("renders all quick entry copy through i18n keys", () => {
    expect(source).toContain('language.t("quickEntry.attach")')
    expect(source).toContain('language.t("quickEntry.attachFailed")')
    expect(/aria-label="[^{]/.test(source)).toBe(false)
  })
})