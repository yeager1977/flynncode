import { describe, expect, test } from "bun:test"
import { Virtualizer, type VirtualizerOptions } from "@tanstack/solid-virtual"
import { atVirtualEnd, createResizeAnchor, timelineScrollTo } from "@/pages/session/timeline/bottom-lock"

function setup(input: { offset: number; anchored: boolean; margin?: number }) {
  const root = document.createElement("div")
  const content = document.createElement("div")
  root.append(content)
  document.body.append(root)
  const writes: number[] = []
  const layout = { reads: 0 }
  const options: VirtualizerOptions<HTMLDivElement, HTMLDivElement> = {
    count: 5,
    estimateSize: () => 60,
    initialOffset: input.offset,
    initialRect: { width: 400, height: 200 },
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    scrollMargin: input.margin ?? 0,
    getScrollElement: () => root,
    scrollToFn: timelineScrollTo(() => content),
    observeElementRect: () => {},
    observeElementOffset: () => {},
  }
  const virtualizer = new Virtualizer(options)
  // Happy DOM has no layout: report the virtual content height, count every read like a forced layout, and record
  // scroll writes. No scroll events echo back, as when the next measurement lands before the browser scrolls.
  Object.defineProperty(root, "scrollHeight", {
    get: () => {
      layout.reads += 1
      return virtualizer.getTotalSize() + (input.margin ?? 0)
    },
  })
  Object.defineProperty(root, "clientHeight", {
    get: () => {
      layout.reads += 1
      return 200
    },
  })
  root.scrollTo = ((target: ScrollToOptions) => writes.push(target.top ?? 0)) as typeof root.scrollTo
  createResizeAnchor({ root: () => root, shouldAnchorBottom: () => input.anchored }).attach(virtualizer)
  virtualizer._willUpdate()
  virtualizer.getVirtualItems()
  writes.length = 0
  layout.reads = 0
  return {
    virtualizer,
    writes,
    layout,
    append() {
      virtualizer.setOptions({ ...options, count: 6 })
      virtualizer._willUpdate()
    },
    dispose: () => root.remove(),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("timeline bottom lock", () => {
  test("a streaming row that grows at the bottom is followed by one virtualizer scroll write", async () => {
    const view = setup({ offset: 100, anchored: true })

    view.virtualizer.resizeItem(4, 110)
    view.virtualizer.resizeItem(4, 180)
    await settle()

    expect(view.writes).toEqual([150, 220])
    expect(view.layout.reads).toBe(0)
    view.dispose()
  })

  test("a resize right after an append keeps the end the append scrolled to", async () => {
    const view = setup({ offset: 100, anchored: true })

    view.append()
    expect(view.writes).toEqual([160])
    view.virtualizer.resizeItem(4, 36)
    await settle()

    // The virtualizer may re-land its own scroll to the end; it never writes a position built on the pre-append offset.
    expect([...new Set(view.writes)]).toEqual([160, 136])
    view.dispose()
  })

  test("after an append the virtualizer reports the end without reading layout", () => {
    const view = setup({ offset: 100, anchored: true })

    view.append()
    view.layout.reads = 0

    expect(atVirtualEnd(view.virtualizer)).toBe(true)
    expect(view.layout.reads).toBe(0)
    view.dispose()
  })

  test("a reader above the end is not at the virtual end", () => {
    const view = setup({ offset: 0, anchored: false })

    expect(atVirtualEnd(view.virtualizer)).toBe(false)
    view.dispose()
  })

  test("the virtual end counts the sticky title margin above the rows", () => {
    const short = setup({ offset: 100, anchored: true, margin: 64 })
    expect(atVirtualEnd(short.virtualizer)).toBe(false)
    short.dispose()

    const end = setup({ offset: 164, anchored: true, margin: 64 })
    expect(atVirtualEnd(end.virtualizer)).toBe(true)
    end.dispose()
  })

  test("a row that grows while the reader is scrolled up writes no scroll position", async () => {
    const view = setup({ offset: 0, anchored: false })

    view.virtualizer.resizeItem(4, 110)
    await settle()

    expect(view.writes).toEqual([])
    view.dispose()
  })
})
