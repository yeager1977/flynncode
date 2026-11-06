import { describe, expect, test } from "bun:test"
import { isHiddenAboveViewport } from "./bottom-lock"

// The sticky title covers the top `margin` pixels of the viewport, so the first row a reader can see starts at
// `offset + margin`. A row that ends above that is out of sight, and when its measured size replaces its estimate the
// rows in view move unless the scroll position follows.
describe("isHiddenAboveViewport", () => {
  test("counts a row that sits wholly under the sticky title", () => {
    // Older history was prepended while the reader sat at the top: the two rows just above the first old row were
    // estimated at 60px, measured at 52px and 24px, and both lie behind the 64px title.
    expect(isHiddenAboveViewport({ start: 6947, size: 60 }, 7003, 64)).toBe(true)
    expect(isHiddenAboveViewport({ start: 6999, size: 60 }, 7003, 64)).toBe(true)
  })

  test("counts a row that is wholly above the viewport", () => {
    expect(isHiddenAboveViewport({ start: 100, size: 60 }, 7003, 64)).toBe(true)
  })

  test("does not count the row that straddles the first visible position", () => {
    // Its lower part is what the reader is looking at, so its own growth is not a reason to scroll.
    expect(isHiddenAboveViewport({ start: 7040, size: 60 }, 7003, 64)).toBe(false)
  })

  test("does not count a row that starts at or below the first visible position", () => {
    expect(isHiddenAboveViewport({ start: 7067, size: 60 }, 7003, 64)).toBe(false)
    expect(isHiddenAboveViewport({ start: 9000, size: 60 }, 7003, 64)).toBe(false)
  })

  test("treats a row ending exactly at the first visible position as hidden", () => {
    expect(isHiddenAboveViewport({ start: 7007, size: 60 }, 7003, 64)).toBe(true)
  })

  test("without a title the viewport top is the first visible position", () => {
    expect(isHiddenAboveViewport({ start: 6940, size: 60 }, 7003, 0)).toBe(true)
    expect(isHiddenAboveViewport({ start: 6960, size: 60 }, 7003, 0)).toBe(false)
  })

  test("the first row at the very top is never hidden", () => {
    // At scroll offset 0 the first row starts right under the title.
    expect(isHiddenAboveViewport({ start: 64, size: 60 }, 0, 64)).toBe(false)
  })
})
