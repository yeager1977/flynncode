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
  test("delegates to the unified activity inbox panel", () => {
    const source = readFileSync(new URL("./dispatch-panel.tsx", import.meta.url), "utf8")
    expect(source).toContain("ActivityInboxPanel")
    expect(source).toContain("DispatchPanel")
  })

  test("does not depend on directory-scoped contexts", () => {
    const source = readFileSync(new URL("./activity-inbox.tsx", import.meta.url), "utf8")
    expect(source).not.toContain("useSDK")
    expect(source).not.toContain("useLocal")
    expect(source).toContain("useServerSDK")
    expect(source).toContain("useModels")
  })

  test("renders inbox tabs and the dispatch send form", () => {
    const source = readFileSync(new URL("./activity-inbox.tsx", import.meta.url), "utf8")
    expect(source).toContain("createMemo")
    expect(source).toContain('"all", "running", "needs-input", "blocked", "done", "failed", "unread"')
    expect(source).toContain("inbox.filterFailed")
    expect(source).toContain("inbox.modelPlaceholder")
    expect(source).toContain("inbox.title")
    expect(source).toContain("inbox.filterUnread")
    expect(source).toContain("inbox.filterRunning")
    expect(source).toContain("inbox.filterNeedsInput")
    expect(source).toContain("inbox.filterBlocked")
    expect(source).toContain("inbox.empty")
    expect(source).toContain("dispatch.send")
    expect(source).toContain("unreadCount()")
    expect(source).toContain("visible()")
    expect(source).toContain('data-action="inbox-open"')
    expect(source).toContain('data-action="inbox-mark-read"')
  })

  test("marks rows read through existing activity sources", () => {
    const source = readFileSync(new URL("./activity-inbox.tsx", import.meta.url), "utf8")
    expect(source).toContain("useDispatchActivity")
    expect(source).toContain("markViewed")
    // Transition detection and OS notification moved to the persistently
    // mounted DispatchActivityProvider; the panel only renders store state.
    expect(source).not.toContain("platform.notify")
    expect(source).not.toContain("resolvedTransition")
  })
})

describe("DispatchActivity", () => {
  test("watches transitions globally and notifies through the platform", () => {
    const source = readFileSync(new URL("./dispatch-activity.tsx", import.meta.url), "utf8")
    expect(source).toContain("createEffect")
    expect(source).toContain("resolvedTransition")
    expect(source).toContain("platform.notify")
    expect(source).toContain("markDispatchRead")
    expect(source).toContain('Persist.global("dispatch.v1")')
  })
})
