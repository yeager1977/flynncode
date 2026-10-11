import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Regression: settings dialogs render under LegacyLayout, which provides
// ServerSDK/ServerSync but NOT the directory-scoped SDKProvider. The routines
// tab called useSDK() and threw "SDK context must be used within a context
// provider" — the renderer crash in the 2026-09-22 desktop build. Dialog
// components must only use server-scoped contexts. (A DOM render test can't
// exercise this: under --conditions=solid the render stub throws before the
// component body runs, so the contract is pinned at the source level.)
describe("SettingsRoutinesV2", () => {
  test("does not depend on the directory-scoped SDK context", () => {
    const source = readFileSync(new URL("./routines.tsx", import.meta.url), "utf8")
    expect(source).not.toContain("useSDK")
    expect(source).toContain("useServerSDK")
  })

  // Run history prefers the server's runs-file endpoint (200 records) and only
  // falls back to the config snapshot's recentRuns (10 records).
  test("reads run history from the server and falls back to recentRuns", () => {
    const source = readFileSync(new URL("./routines.tsx", import.meta.url), "utf8")
    expect(source).toContain("client.global.routinesRuns")
    expect(source).toContain("runHistory[routine.id] ?? routine.recentRuns")
  })
})