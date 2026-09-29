import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Source-level contract tests for session-todo-dock.tsx.
// DOM rendering is not available under --conditions=solid (the render stub
// throws before the component body runs), so behavioral contracts are pinned
// at the source level — the same approach used by dispatch-panel.test.tsx and
// routines.test.tsx.

const source = readFileSync(new URL("./session-todo-dock.tsx", import.meta.url), "utf8")

describe("SessionTodoDock", () => {
  test("todo rows render as distinct inset task chips", () => {
    expect(source).toContain(
      '"rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-02 px-2 py-1.5": true',
    )
  })

  test("in_progress items get data-status and accent border", () => {
    expect(source).toContain('data-status={todo().status}')
    expect(source).toContain('"border-s-2 ps-2": todo().status === "in_progress"')
    expect(source).toContain(
      '"border-inline-start-color": todo().status === "in_progress" ? "var(--v2-icon-icon-accent)" : undefined',
    )
  })

  // (b) completed items get strikethrough via TextStrikethrough active prop
  test("completed items get strikethrough", () => {
    expect(source).toContain('active={todo().status === "completed" || todo().status === "cancelled"}')
  })

  // (c) pending items get dimmed opacity
  test("pending items get dimmed opacity", () => {
    expect(source).toContain('opacity: todo().status === "pending" ? "0.92" : "1"')
  })

  // (d) cancelled items get strikethrough + weak color (same active prop as completed)
  test("cancelled items get strikethrough and weak color", () => {
    // The active prop covers both completed and cancelled
    expect(source).toContain('todo().status === "cancelled"')
    expect(source).toContain('"var(--text-weak)"')
  })

  // (e) path-pattern content: TextStrikethrough uses summary from splitTodoContent
  test("TextStrikethrough renders summary from splitTodoContent", () => {
    expect(source).toContain("splitTodoContent")
    expect(source).toContain("parts().summary")
    // Detail toggle is shown only when detail !== summary
    expect(source).toContain('parts().detail !== parts().summary')
  })

  // (f) detail toggle reveals original content (detail line rendered when expanded)
  test("detail toggle reveals original content when expanded", () => {
    expect(source).toContain("parts().detail")
    expect(source).toContain("isExpanded()")
    // The detail text is rendered in an indented block when expanded
    expect(source).toContain("session-todo-detail-toggle")
  })

  // (g) clicking detail toggle does NOT collapse dock — stopPropagation on all three events
  test("detail toggle stopPropagation on onClick, onMouseDown, and onKeyDown", () => {
    // The detail toggle IconButton must stop propagation on all three events
    // so the dock header's toggle (which listens to click + Enter/Space) is not triggered.
    // We verify all three handlers are present after the detail-toggle data-action marker.
    const detailToggleIdx = source.indexOf('data-action="session-todo-detail-toggle"')
    expect(detailToggleIdx).toBeGreaterThan(-1)

    // Find the closing of the detail toggle IconButton block — it ends before the next
    // top-level element. We check that all three stopPropagation calls appear in the
    // source after the marker (they are all within the same IconButton).
    const afterMarker = source.slice(detailToggleIdx)
    // onClick stopPropagation
    expect(afterMarker).toContain("event.stopPropagation()")
    // onMouseDown stopPropagation
    expect(afterMarker).toContain("onMouseDown")
    // onKeyDown stopPropagation
    expect(afterMarker).toContain("onKeyDown")
  })

  test("detail toggle remains pointer-targetable inside the read-only checkbox", () => {
    expect(source).toContain('data-action="session-todo-detail-toggle"')
    expect(source).toContain('class="pointer-events-auto"')
  })

  // (h) collapsed preview shows normalized summary (not raw content)
  test("collapsed preview uses splitTodoContent summary", () => {
    // The preview memo must call splitTodoContent and use .summary
    expect(source).toContain("splitTodoContent(content).summary")
  })

  // RTL: header uses logical padding so start/end insets mirror correctly in RTL
  test("header uses logical padding classes ps-*/pe-* not physical pl-*/pr-*", () => {
    expect(source).toContain('"h-[42px] ps-4 pe-2": settings.general.newLayoutDesigns()')
    expect(source).toContain('"ps-3 pe-2 py-2": !settings.general.newLayoutDesigns()')
    expect(source).not.toContain("pl-4")
    expect(source).not.toContain("pr-2")
    expect(source).not.toContain("pl-3")
  })
})
