import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./permissions.tsx", import.meta.url), "utf8")

describe("settings permissions page", () => {
  test("writes server config keys for approval and sandbox", () => {
    expect(source).toContain('"approval"')
    expect(source).toContain('"sandbox"')
  })

  test("full-access is confirmation-gated", () => {
    expect(source).toContain("settings.permissions.fullAccess.confirm")
    expect(source).toContain('variant="danger"')
  })

  test("registered in the settings dialog", () => {
    const dialog = readFileSync(new URL("./dialog-settings-v2.tsx", import.meta.url), "utf8")
    expect(dialog).toContain("./permissions")
  })

  test("copy comes from i18n keys, not hardcoded English", () => {
    expect(source).toContain("settings.permissions.approval.label")
    expect(source).toContain("settings.permissions.sandbox.label")
    expect(source).toContain("settings.permissions.fullAccess.button")
  })
})