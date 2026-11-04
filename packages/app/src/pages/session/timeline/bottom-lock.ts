import { elementScroll, type Virtualizer } from "@tanstack/solid-virtual"

type TimelineVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>

type TimelineScrollTo = (
  offset: number,
  options: { adjustments?: number; behavior?: ScrollBehavior },
  instance: TimelineVirtualizer,
) => void

// The virtualizer (`anchorTo: "end"`) is the single owner of the timeline bottom lock: while it is at the end, its
// own resize adjustment is the only scroll write, and nothing here reads layout on that path.
export function timelineScrollTo(content: () => HTMLDivElement | undefined): TimelineScrollTo {
  return (offset, options, instance) => {
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
//
// Measurements arrive in batches (one ResizeObserver callback per frame, or many rows mounted at once). Each
// measurement would otherwise notify the view and write the scroll position on its own, forcing a layout per row.
// Inside a batch the virtualizer state updates immediately, while its adjustment scroll write and its view
// notification are deferred to one flush after the batch, still before the frame paints. Nothing here reads layout.
export function createResizeAnchor(input: { shouldAnchorBottom: () => boolean }) {
  const state = {
    pinned: [] as number[],
    frame: undefined as number | undefined,
    measuring: false,
    pending: undefined as { scroll?: () => void; notify?: () => void } | undefined,
  }
  const flush = () => {
    const batch = state.pending
    state.pending = undefined
    batch?.scroll?.()
    batch?.notify?.()
  }
  const defer = (work: { scroll?: () => void; notify?: () => void }) => {
    if (!state.pending) queueMicrotask(flush)
    state.pending = { ...state.pending, ...work }
  }
  const attach = (virtualizer: TimelineVirtualizer) => {
    const resizeItem = virtualizer.resizeItem
    // `notify` is private in virtual-core; it is how a measurement reaches the view (a full virtual-item reconcile).
    const core = virtualizer as unknown as { notify: (sync: boolean) => void }
    const notify = core.notify
    core.notify = (sync) => {
      if (!state.measuring) return notify(sync)
      defer({ notify: () => notify(sync) })
    }
    virtualizer.resizeItem = (index, size) => {
      const item = virtualizer.measurementsCache[index]
      const previous = item ? (virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
      const viewport = virtualizer.scrollRect?.height ?? 0
      const range = virtualizer.range
      if (range && previous !== undefined && Math.abs(size - previous) > viewport) {
        state.pinned = Array.from(
          { length: range.endIndex - range.startIndex + 1 },
          (_, offset) => range.startIndex + offset,
        )
        if (state.frame !== undefined) cancelAnimationFrame(state.frame)
        state.frame = requestAnimationFrame(() => {
          state.frame = requestAnimationFrame(() => {
            state.frame = undefined
            state.pinned = []
          })
        })
      }
      // A throwing measurement must not leave later notifies and scroll writes deferred forever.
      state.measuring = true
      try {
        resizeItem(index, size)
      } finally {
        state.measuring = false
      }
    }
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
      if (input.shouldAnchorBottom()) return false
      if (virtualizer.scrollOffset === null) return false
      return isHiddenAboveViewport(item, virtualizer.scrollOffset, virtualizer.options.scrollMargin)
    }
  }
  return {
    attach,
    // Wraps the timeline `scrollToFn`: adjustment writes made while measuring land once, after the batch, at the
    // latest target. Any other write supersedes a deferred one.
    scrollTo:
      (scrollTo: TimelineScrollTo): TimelineScrollTo =>
      (offset, options, instance) => {
        if (state.measuring && options.adjustments !== undefined) {
          defer({ scroll: () => scrollTo(offset, options, instance) })
          return
        }
        if (state.pending) state.pending.scroll = undefined
        scrollTo(offset, options, instance)
      },
    pinned: () => state.pinned,
    cancel: () => {
      if (state.frame !== undefined) cancelAnimationFrame(state.frame)
    },
  }
}

// True when a row lies wholly above what the reader can see, so a change to its size moves the rows in view and the
// scroll position has to follow. The sticky title covers the top `margin` pixels of the viewport, so the first visible
// position is `offset + margin`; a row that merely sits above the viewport edge but under the title still counts.
// The row straddling that position is the one being read: its own growth is not a reason to scroll.
export function isHiddenAboveViewport(item: { start: number; size: number }, offset: number, margin: number) {
  return item.start + item.size <= offset + margin
}

// True when the virtualizer's own offset already sits at the end of its content. Uses virtual sizes only, so it
// never forces a layout.
export function atVirtualEnd(virtualizer: TimelineVirtualizer) {
  const size = virtualizer.scrollRect?.height
  if (size === undefined || virtualizer.scrollOffset === null) return false
  // Item offsets include the scroll margin (the sticky title above the rows); the total size does not.
  return virtualizer.getTotalSize() + virtualizer.options.scrollMargin - size - virtualizer.scrollOffset <= 1
}
