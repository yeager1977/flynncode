import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Regression: the dispatch panel is shown via dialog.show() from the legacy
// sidebar (LegacyLayout), which provides ServerSDK/ServerSync/Models but NOT
// the directory-scoped SDKProvider/LocalProvider. useSDK() throws "SDK context
// must be used within a context provider" and useLocal() throws too (it calls
// useSDK internally) — the same renderer-crash class as the routines tab.
// (A DOM render test can't exercise this: under --conditions=solid the render
// stub throws before the component body runs, so the contract is pinned at
// the source level.)
describe("DispatchPanel", () => {
  test("does not depend on directory-scoped contexts", () => {
    const source = readFileSync(new URL("./dispatch-panel.tsx", import.meta.url), "utf8")
    expect(source).not.toContain("useSDK")
    expect(source).not.toContain("useLocal")
    expect(source).toContain("useServerSDK")
    expect(source).toContain("useModels")
  })
})