import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const dialog = readFileSync(new URL("./dialog-connect-provider.tsx", import.meta.url), "utf8")
const platform = readFileSync(new URL("../context/platform.tsx", import.meta.url), "utf8")
const renderer = readFileSync(
  new URL("../../../desktop/src/renderer/index.tsx", import.meta.url),
  "utf8",
)

describe("muse import action", () => {
  test("dialog gates on meta provider and platform capability", () => {
    expect(dialog).toContain('"meta"')
    expect(dialog).toContain("museAuthStatus")
    expect(dialog).toContain("museAuthSync")
  })

  test("dialog reuses the existing completion path on success", () => {
    expect(dialog).toContain("complete()")
  })

  test("platform declares both methods as optional", () => {
    expect(platform).toContain("museAuthStatus?")
    expect(platform).toContain("museAuthSync?")
  })

  test("renderer binds both window.api invokes", () => {
    expect(renderer).toContain("museAuthStatus")
    expect(renderer).toContain("museAuthSync")
  })

  test("copy comes from i18n keys, not hardcoded English", () => {
    expect(dialog).toContain("provider.connect.museImport")
    expect(dialog).not.toMatch(/>(Import from Muse CLI|Muse CLI)[^<]*</)
  })
})
