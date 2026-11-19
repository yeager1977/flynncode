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

  test("select option labels are translated, including the already-active full access", () => {
    // SelectV2 renders the label prop's return value verbatim, so a bare key
    // string leaks straight into the UI. Every option label must call
    // language.t with its key.
    for (const key of [
      "settings.permissions.approval.manual",
      "settings.permissions.approval.acceptEdits",
      "settings.permissions.approval.auto",
      "settings.permissions.sandbox.readonly",
      "settings.permissions.sandbox.workspace",
      "settings.permissions.sandbox.fullAccess",
    ]) {
      expect(source).toContain(`language.t("${key}")`)
    }
  })

  test("no label function returns a bare i18n key", () => {
    expect(source).not.toMatch(/return "settings\.permissions\./)
  })

  test("action permission rows cover the single-decision keys", () => {
    for (const key of [
      "worktree",
      "worktree_discard",
      "archive",
      "question",
      "webfetch",
      "websearch",
      "doom_loop",
      "github-triage",
      "github-pr-search",
    ]) {
      expect(source).toContain(`"${key}"`)
    }
  })

  test("action row labels come from the shared tool i18n keys", () => {
    expect(source).toContain("settings.permissions.tool.${permission}.${part}")
    expect(source).toContain('language.t("settings.permissions.action.unset")')
  })

  test("an unset action removes its config key instead of pinning ask", () => {
    // policyToConfig deletes unset action keys so a saved value can return to
    // the built-in default.
    expect(source).toContain("delete base[key]")
  })
})