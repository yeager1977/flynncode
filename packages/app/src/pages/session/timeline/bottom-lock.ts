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
  let pinned: number[] = []
  let frame: number | undefined
  let measuring = false
  let pending: { scroll?: () => void; notify?: () => void } | undefined
  const flush = () => {
    const batch = pending
    pending = undefined
    batch?.scroll?.()
    batch?.notify?.()
  }
  const defer = (work: { scroll?: () => void; notify?: () => void }) => {
    if (!pending) queueMicrotask(flush)
    pending = { ...pending, ...work }
  }
  const attach = (virtualizer: TimelineVirtualizer) => {
    const resizeItem = virtualizer.resizeItem
    // `notify` is private in virtual-core; it is how a measurement reaches the view (a full virtual-item reconcile).
    const core = virtualizer as unknown as { notify: (sync: boolean) => void }
    const notify = core.notify
    core.notify = (sync) => {
      if (!measuring) return notify(sync)
      defer({ notify: () => notify(sync) })
    }
    virtualizer.resizeItem = (index, size) => {
      const item = virtualizer.measurementsCache[index]
      const previous = item ? (virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
      const viewport = virtualizer.scrollRect?.height ?? 0
      const range = virtualizer.range
      if (range && previous !== undefined && Math.abs(size - previous) > viewport) {
        pinned = Array.from({ length: range.endIndex - range.startIndex + 1 }, (_, offset) => range.startIndex + offset)
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            frame = undefined
            pinned = []
          })
        })
      }
      measuring = true
      resizeItem(index, size)
      measuring = false
    }
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
      if (input.shouldAnchorBottom()) return false
      const first = virtualizer.range?.startIndex
      return first !== undefined && item.index < first
    }
  }
  return {
    attach,
    // Wraps the timeline `scrollToFn`: adjustment writes made while measuring land once, after the batch, at the
    // latest target. Any other write supersedes a deferred one.
    scrollTo:
      (scrollTo: TimelineScrollTo): TimelineScrollTo =>
      (offset, options, instance) => {
        if (measuring && options.adjustments !== undefined) {
          defer({ scroll: () => scrollTo(offset, options, instance) })
          return
        }
        if (pending) pending.scroll = undefined
        scrollTo(offset, options, instance)
      },
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
