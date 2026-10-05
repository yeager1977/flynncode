import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Same regression guard as the routines tab: settings dialogs render under
// LegacyLayout, which provides ServerSDK/ServerSync but NOT the
// directory-scoped SDKProvider. The worktree tab must only use server-scoped
// contexts.
describe("SettingsWorktreeV2", () => {
  test("does not depend on the directory-scoped SDK context", () => {
    const source = readFileSync(new URL("./worktree.tsx", import.meta.url), "utf8")
    expect(source).not.toContain("useSDK")
    expect(source).toContain("useServerSDK")
  })

  test("all user-visible copy goes through i18n keys", () => {
    const source = readFileSync(new URL("./worktree.tsx", import.meta.url), "utf8")
    expect(source).toContain('language.t("settings.worktree.')
    // No hardcoded English copy in the component markup.
    const literals = source.match(/>\s*[A-Z][a-z]+[^<{]*</g) ?? []
    expect(literals).toEqual([])
  })

  test("is registered as a settings tab", () => {
    const source = readFileSync(new URL("./dialog-settings-v2.tsx", import.meta.url), "utf8")
    expect(source).toContain('value="worktree"')
    expect(source).toContain("SettingsWorktreeV2")
  })
})