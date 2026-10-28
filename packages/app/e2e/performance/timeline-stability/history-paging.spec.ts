import { expect, test, type Page } from "@playwright/test"
import { historyMessages, setupTimeline } from "./fixture"

test.describe("history paging", () => {
  test("loads 50 older messages about two screens before the top and keeps the visible rows in place", async ({
    page,
  }) => {
    const gate = Promise.withResolvers<void>()
    const older: string[] = []
    // Only pages requested once the reader scrolls are held; the startup fill loads freely.
    const armed = { value: false }
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (!armed.value) return
      if (!url.pathname.endsWith("/message")) return
      if (!url.searchParams.get("before") && !url.searchParams.get("cursor")) return
      older.push(url.searchParams.get("limit") ?? "")
    })
    await setupTimeline(page, {
      messages: historyMessages(120),
      paged: true,
      beforeMessagesResponse: async (input) => {
        if (input.before && armed.value) await gate.promise
      },
    })
    const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
    await page.waitForLoadState("networkidle")
    await settle(page, 10)
    armed.value = true
    const box = await scroller.boundingBox()
    if (!box) throw new Error("Missing timeline scroller")
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

    const deadline = Date.now() + 30_000
    while (older.length === 0) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for an older history page")
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(80)
    }
    const view = await scroller.evaluate((element) => ({ top: element.scrollTop, height: element.clientHeight }))
    // The request starts well before the reader reaches the top, not within the last few hundred pixels.
    expect(view.top).toBeGreaterThan(view.height / 2)
    expect(older[0]).toBe("50")

    await settle(page, 10)
    const keys = await visibleKeys(page)
    expect(keys.length).toBeGreaterThan(0)
    const before = await positions(page, keys)
    const count = await page.locator("[data-timeline-key]").count()
    const landed = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname.endsWith("/message") && !!(url.searchParams.get("before") || url.searchParams.get("cursor"))
    })
    gate.resolve()
    await landed
    await expect.poll(() => page.locator("[data-timeline-key]").count()).toBeGreaterThanOrEqual(count)
    await settle(page, 30)

    expect(await positions(page, keys)).toEqual(before)
  })
})

function settle(page: Page, frames: number) {
  return page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        const tick = (remaining: number) => {
          if (remaining <= 0) return resolve()
          requestAnimationFrame(() => tick(remaining - 1))
        }
        tick(frames)
      }),
    frames,
  )
}

function visibleKeys(page: Page) {
  return page.evaluate(() => {
    const root = document
      .querySelector<HTMLElement>("[data-timeline-virtual-content]")
      ?.closest(".scroll-view__viewport")
    if (!root) return []
    const view = root.getBoundingClientRect()
    return [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
      .filter((row) => {
        const rect = row.getBoundingClientRect()
        return rect.top >= view.top && rect.bottom <= view.bottom
      })
      .flatMap((row) => (row.dataset.timelineKey ? [row.dataset.timelineKey] : []))
      .slice(0, 3)
  })
}

function positions(page: Page, keys: string[]) {
  return page.evaluate((keys) => {
    const root = document
      .querySelector<HTMLElement>("[data-timeline-virtual-content]")
      ?.closest(".scroll-view__viewport")
    if (!root) throw new Error("Missing timeline scroller")
    const top = root.getBoundingClientRect().top
    return keys.map((key) => {
      const row = root.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(key)}"]`)
      if (!row) throw new Error(`Missing timeline row: ${key}`)
      return Math.round(row.getBoundingClientRect().top - top)
    })
  }, keys)
}
