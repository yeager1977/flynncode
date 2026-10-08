import { describe, expect, test } from "bun:test"
import { historyConsentKey, loadHistoryConsent, saveHistoryConsent } from "./history-consent"

describe("history consent", () => {
  test("defaults to off and round-trips per session", () => {
    expect(historyConsentKey("ses_1")).toBe("opencode.session-history.consent.ses_1")
    expect(loadHistoryConsent("ses_test_default_off")).toBe(false)
    saveHistoryConsent("ses_test_roundtrip", true)
    expect(loadHistoryConsent("ses_test_roundtrip")).toBe(true)
    saveHistoryConsent("ses_test_roundtrip", false)
    expect(loadHistoryConsent("ses_test_roundtrip")).toBe(false)
  })
})
