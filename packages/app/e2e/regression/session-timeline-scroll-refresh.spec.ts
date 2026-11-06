import { expect, test, type Locator, type Page } from "@playwright/test"
import {
  assistantMessage,
  historyMessages,
  setupTimeline,
  textPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

// A background poll must never blank the session route. The browser drops the scroll offset of an element that leaves
// the document, so a reader scrolled up through a long session would be thrown back to the oldest loaded history.
// The header once polled provider usage every 60 seconds through a read that registered with the route's <Suspense>.
test.use({ viewport: { width: 1400, height: 700 } })

test("keeps the reader's place while background polls run", async ({ page }) => {
  await page.clock.install()
  await setupTimeline(page, { messages: longSession(), reducedMotion: true })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await watchTimelineDetach(page)
  const before = await scrollAwayFromBottom(page, scroller)
  const startedAt = await page.evaluate(() => Date.now())

  // Two full minutes covers every 5 and 60 second poll and every stale-time expiry the page schedules.
  for (const _ of Array.from({ length: 13 })) await page.clock.runFor(10_000)

  expect(await page.evaluate(() => Date.now())).toBeGreaterThanOrEqual(startedAt + 130_000)
  expect(await timelineDetachCount(page)).toBe(0)
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before.top)
  expect(await firstVisibleKey(scroller)).toBe(before.key)
})

// These events refetch the app-wide provider lists. Anything on the session route that reads those lists without a
// guard would blank the route the same way, so each one must leave the reader where they were.
for (const type of ["catalog.updated", "integration.connection.updated", "server.instance.disposed"]) {
  test(`keeps the reader's place when ${type} refreshes the provider lists`, async ({ page }) => {
    let providerRequests = 0
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (path === "/provider" || path === "/provider/connected") providerRequests += 1
    })
    const timeline = await setupTimeline(page, { messages: longSession(), reducedMotion: true })
    const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
    await watchTimelineDetach(page)
    const before = await scrollAwayFromBottom(page, scroller)
    const requested = providerRequests

    await timeline.transport.writeRaw(`data: ${JSON.stringify({ directory: "global", payload: { type, properties: {} } })}\n\n`)
    await expect.poll(() => providerRequests).toBeGreaterThan(requested)
    await expect.poll(() => timelineDetachCount(page)).toBe(0)

    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before.top)
    expect(await firstVisibleKey(scroller)).toBe(before.key)
  })
}

// A message can name a provider that is no longer connected. Resolving its model name loads the full provider catalog
// in idle time, a few seconds after the session opens - exactly when a reader has started scrolling up. That load
// must not blank the route either.
test("keeps the timeline mounted when the catalog loads for a provider that is no longer connected", async ({ page }) => {
  const catalogRequests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/provider") catalogRequests.push(request.url())
  })
  // Installed before the page loads: the catalog load starts right after the first render, before the test can attach.
  await page.addInitScript(() => {
    const target = window as typeof window & { __timelineDetached?: number }
    target.__timelineDetached = 0
    new MutationObserver((records) => {
      records.forEach((record) =>
        record.removedNodes.forEach((node) => {
          if (!(node instanceof Element)) return
          if (node.matches("[data-timeline-virtual-content]") || node.querySelector("[data-timeline-virtual-content]"))
            target.__timelineDetached = (target.__timelineDetached ?? 0) + 1
        }),
      )
    }).observe(document, { childList: true, subtree: true })
  })
  await setupTimeline(page, { messages: retiredProviderSession(), reducedMotion: true })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await expect(scroller).toBeVisible()

  // Proves the lookup ran, so a quiet timeline below is not a vacuous pass.
  await expect.poll(() => catalogRequests.length).toBeGreaterThan(0)
  await expect.poll(() => timelineDetachCount(page)).toBe(0)
})

function retiredProviderSession() {
  return longSession().map((message) =>
    message.info.role === "assistant"
      ? { ...message, info: { ...message.info, providerID: "retired-provider", modelID: "retired-model" } }
      : message,
  )
}

function longSession() {
  return [
    ...historyMessages(60),
    userMessage(),
    assistantMessage([textPart("prt_scroll_refresh_tail", "The latest response.")]),
  ]
}

async function scrollAwayFromBottom(page: Page, scroller: Locator) {
  const scrollTop = () => scroller.evaluate((element) => element.scrollTop)
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(3000)
  const bottom = await scrollTop()
  await scroller.hover()
  await page.mouse.wheel(0, -2000)
  await expect.poll(scrollTop).toBeLessThan(bottom - 1500)
  // Wait for the offset to stop moving so the later comparison is against the settled position.
  await expect
    .poll(async () => {
      const first = await scrollTop()
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      return first === (await scrollTop())
    })
    .toBe(true)
  return { top: await scrollTop(), key: await firstVisibleKey(scroller) }
}

function firstVisibleKey(scroller: Locator) {
  return scroller.evaluate((viewport) => {
    const view = viewport.getBoundingClientRect()
    return (
      [...viewport.querySelectorAll<HTMLElement>("[data-timeline-key]")].find((row) => row.getBoundingClientRect().bottom > view.top)
        ?.dataset.timelineKey ?? null
    )
  })
}

async function watchTimelineDetach(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & { __timelineDetached?: number }
    target.__timelineDetached = 0
    new MutationObserver((records) => {
      records.forEach((record) =>
        record.removedNodes.forEach((node) => {
          if (!(node instanceof Element)) return
          if (node.matches("[data-timeline-virtual-content]") || node.querySelector("[data-timeline-virtual-content]"))
            target.__timelineDetached = (target.__timelineDetached ?? 0) + 1
        }),
      )
    }).observe(document.body, { childList: true, subtree: true })
  })
}

function timelineDetachCount(page: Page) {
  return page.evaluate(() => (window as typeof window & { __timelineDetached?: number }).__timelineDetached ?? -1)
}
