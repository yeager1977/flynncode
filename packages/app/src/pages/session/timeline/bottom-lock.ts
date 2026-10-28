import { elementScroll, type Virtualizer } from "@tanstack/solid-virtual"

type TimelineVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>

// The virtualizer (`anchorTo: "end"`) is the single owner of the timeline bottom lock: while it is at the end, its
// own resize adjustment is the only scroll write, and nothing here reads layout on that path.
export function timelineScrollTo(content: () => HTMLDivElement | undefined) {
  return (
    offset: number,
    options: { adjustments?: number; behavior?: ScrollBehavior },
    instance: TimelineVirtualizer,
  ) => {
    // Expose the computed range before core writes an anchor correction so the browser does not clamp it to the old height.
    const element = content()
    if (element) element.style.height = `${instance.getTotalSize()}px`
    elementScroll(offset, options, instance)
    // Core carries only adjustment writes into `scrollOffset` before the scroll event echoes back. Carry absolute
    // writes too (the scroll to the end after an append), or the next bottom-lock adjustment builds on a stale offset.
    if (options.adjustments === undefined && options.behavior !== "smooth") instance.scrollOffset = offset
  }
}

// Pins the rows on screen while a row jumps by more than a viewport, and keeps rows above the viewport from
// shifting the reading position unless the timeline follows the bottom.
export function createResizeAnchor(input: {
  root: () => HTMLDivElement | undefined
  shouldAnchorBottom: () => boolean
}) {
  let pinned: number[] = []
  let frame: number | undefined
  const attach = (virtualizer: TimelineVirtualizer) => {
    const resizeItem = virtualizer.resizeItem
    virtualizer.resizeItem = (index, size) => {
      const item = virtualizer.measurementsCache[index]
      const previous = item ? (virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
      const root = input.root()
      // The viewport height comes from the virtualizer's rect observer, so a streaming resize reads no layout.
      const viewport = virtualizer.scrollRect?.height ?? root?.clientHeight ?? 0
      if (root && previous !== undefined && Math.abs(size - previous) > viewport) {
        const view = root.getBoundingClientRect()
        pinned = [...root.querySelectorAll<HTMLElement>("[data-index]")]
          .filter((element) => {
            const rect = element.getBoundingClientRect()
            return rect.bottom > view.top && rect.top < view.bottom
          })
          .map((element) => Number(element.dataset.index))
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            frame = undefined
            pinned = []
          })
        })
      }
      resizeItem(index, size)
    }
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
      if (input.shouldAnchorBottom()) return false
      const first = virtualizer.range?.startIndex
      return first !== undefined && item.index < first
    }
  }
  return {
    attach,
    pinned: () => pinned,
    cancel: () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
    },
  }
}

// True when the virtualizer's own offset already sits at the end of its content. Uses virtual sizes only, so it
// never forces a layout.
export function atVirtualEnd(virtualizer: TimelineVirtualizer) {
  const size = virtualizer.scrollRect?.height
  if (size === undefined || virtualizer.scrollOffset === null) return false
  // Item offsets include the scroll margin (the sticky title above the rows); the total size does not.
  return virtualizer.getTotalSize() + virtualizer.options.scrollMargin - size - virtualizer.scrollOffset <= 1
}
