import { observeElementOffset, type Virtualizer } from "@tanstack/solid-virtual"

export function observeElementOffsetReconnectAware<TScrollElement extends Element, TItemElement extends Element>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  callback: (offset: number, isScrolling: boolean) => void,
) {
  let active = true
  const deliver = (offset: number, isScrolling: boolean) => {
    if (!active) return
    callback(offset, isScrolling)
  }
  const cleanupOffset = observeElementOffset(instance, deliver)
  const element = instance.scrollElement
  const targetWindow = instance.targetWindow
  const root = element?.closest("main") ?? element?.ownerDocument.body
  if (!element || !targetWindow || !root)
    return () => {
      active = false
      cleanupOffset?.()
    }

  let removed = false
  let frame: number | undefined
  const clearCheck = () => {
    if (frame === undefined) return
    targetWindow.cancelAnimationFrame(frame)
    frame = undefined
  }
  const startCheck = () => {
    clearCheck()
    const deadline = targetWindow.performance.now() + instance.options.isScrollingResetDelay
    let framesAfterDeadline = 0
    const check = (time: number) => {
      frame = undefined
      if (element.isConnected) {
        const offset = instance.options.horizontal
          ? element.scrollLeft * (instance.options.isRtl ? -1 : 1)
          : element.scrollTop
        if (instance.scrollOffset === null || Math.abs(offset - instance.scrollOffset) > 1) deliver(offset, false)
      }
      if (time >= deadline) framesAfterDeadline += 1
      if (framesAfterDeadline >= 2) return
      frame = targetWindow.requestAnimationFrame(check)
    }
    frame = targetWindow.requestAnimationFrame(check)
  }
  // Only the scroll element's ancestors can detach it, so watch their child lists instead of the whole page
  // (a subtree observer gets a record for every token appended while code streams). While detached, the
  // element can come back under any parent, so watch the whole root until it reconnects.
  const watch = () => {
    observer.disconnect()
    if (removed) {
      observer.observe(root, { childList: true, subtree: true })
      return
    }
    ancestors(element, root).forEach((node) => observer.observe(node, { childList: true }))
  }
  const observer = new targetWindow.MutationObserver((records) => {
    if (!active) return
    const detached = records.some((record) => mutationNodesContainElement(record.removedNodes, element))
    const wasRemoved = removed
    if (detached) {
      removed = true
      clearCheck()
    }
    if (removed && element.isConnected) {
      removed = false
      startCheck()
    }
    if (detached || wasRemoved !== removed) watch()
  })
  // Session routes are replaced below persistent main; body is the fallback for isolated hosts.
  watch()

  return () => {
    active = false
    observer.disconnect()
    clearCheck()
    cleanupOffset?.()
  }
}

export function mutationNodesContainElement(nodes: Iterable<Node>, element: Element) {
  return [...nodes].some((node) => node === element || node.contains(element))
}

function ancestors(element: Element, root: Element) {
  const nodes: Node[] = []
  for (let node = element.parentNode; node; node = node.parentNode) {
    nodes.push(node)
    if (node === root) break
  }
  return nodes
}
