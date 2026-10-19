import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// TanStack Virtual recomputes its visible range on scroll and resize events
// only. FileTreeV2's `rows()` grows when a directory expands while the scroll
// offset stays the same, so the virtualizer kept rendering the pre-expansion
// row set: child rows of the expanded directory never appeared until the next
// scroll. The component therefore re-measures (public re-notify API) whenever
// the row list changes. (Pinned at source level: a DOM render test can't run —
// bun compiles solid JSX as React under the repo's `jsx: preserve` tsconfigs.)
describe("FileTreeV2 virtualizer refresh", () => {
  const source = readFileSync(new URL("./file-tree-v2.tsx", import.meta.url), "utf8")

  test("re-measures the virtualizer when the flat row list changes", () => {
    expect(source).toContain("createEffect(on(rows,")
    expect(source).toContain("virtualizer.measure()")
  })

  test("keeps the notify effect scoped to the row list, not scroll state", () => {
    const effect = source.match(/createEffect\(on\(rows[\s\S]*?virtualizer\.measure\(\)\)\)\)/)?.[0]
    expect(effect).toBeTruthy()
    expect(effect).not.toContain("getScrollElement")
    expect(effect).not.toContain("scrollToIndex")
  })
})
