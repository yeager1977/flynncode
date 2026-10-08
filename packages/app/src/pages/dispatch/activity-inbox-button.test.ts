import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// The legacy layout no longer renders after the old-interface sunset, so the
// inbox and quick entry must be mounted by the new layout. Render tests can't
// run these components under --conditions=solid, so the contract is pinned at
// the source level like the dispatch panel tests.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

describe("new layout activity entry points", () => {
  test("mounts the inbox button and quick entry overlay", () => {
    const source = read("../layout-new.tsx")
    expect(source).toContain("actions={<ActivityInboxButton />}")
    expect(source).toContain("<QuickEntryOverlay />")
  })

  test("inbox button uses the inbox icon and opens the activity panel", () => {
    const source = read("./activity-inbox-button.tsx")
    expect(source).toContain('<IconV2 name="inbox" />')
    expect(source).toContain("ActivityInboxPanel")
    expect(source).toContain("useInboxBadge()")
  })

  test("dispatch provider wraps the shell so the inbox can read it", () => {
    const source = read("../../app.tsx")
    expect(source).not.toContain("<DispatchActivityProvider />")
    expect(source).toContain("</DispatchActivityProvider>")
  })

  test("quick entry can always be dismissed", () => {
    const source = read("../../components/quick-entry.tsx")
    expect(source).toContain('makeEventListener(window, "keydown"')
    expect(source).toContain('data-action="quick-entry-close"')
    expect(source).toContain("event.target === event.currentTarget")
  })
})
