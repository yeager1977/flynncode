import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("SessionHistoryPanel", () => {
  test("uses i18n keys and consent gate, never hardcodes copy", () => {
    const source = readFileSync(new URL("./session-history-panel.tsx", import.meta.url), "utf8")
    expect(source).toContain('language.t("history.title")')
    expect(source).toContain('language.t("history.search.placeholder")')
    expect(source).toContain('language.t("history.consent.enable")')
    expect(source).toContain("loadHistoryConsent")
    expect(source).toContain("filterHistoryEntries")
    expect(source).not.toContain("Screenshot")
  })
})
