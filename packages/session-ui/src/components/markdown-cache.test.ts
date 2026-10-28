import { describe, expect, mock, test } from "bun:test"

// Bun cannot load Vite's `?worker&url` imports; point the client at the real worker module instead.
const workerUrl = new URL("./markdown.worker.ts", import.meta.url).href
mock.module("./markdown.worker.ts?worker&url", () => ({ default: workerUrl }))

const { getCachedMarkdown, markdownCacheBytes, touchCachedMarkdown } = await import("./markdown-cache")

const entry = (raw: string, html: string) => ({ raw, hash: String(raw.length), html })

describe("markdown cache", () => {
  test("keeps every finished block that fits the byte budget", () => {
    // A long session has far more than 200 finished blocks; re-mounted rows must still find their HTML.
    Array.from({ length: 500 }, (_, index) =>
      touchCachedMarkdown(`count:${index}`, entry(`text ${index}`, `<p>text ${index}</p>`)),
    )

    expect(getCachedMarkdown("count:0")?.html).toBe("<p>text 0</p>")
    expect(getCachedMarkdown("count:499")?.html).toBe("<p>text 499</p>")
  })

  test("evicts the least recently used blocks once over the byte budget", () => {
    // Each block holds about a quarter of the budget (two bytes per UTF-16 code unit).
    const html = "x".repeat(markdownCacheBytes / 8)
    ;["a", "b", "c"].forEach((key) => touchCachedMarkdown(`bytes:${key}`, entry(key, html)))
    const a = getCachedMarkdown("bytes:a")
    if (a) touchCachedMarkdown("bytes:a", a)

    touchCachedMarkdown("bytes:d", entry("d", html))
    touchCachedMarkdown("bytes:e", entry("e", html))

    expect(getCachedMarkdown("count:0")).toBeUndefined()
    expect(getCachedMarkdown("bytes:b")).toBeUndefined()
    expect(getCachedMarkdown("bytes:c")).toBeUndefined()
    expect(["bytes:a", "bytes:d", "bytes:e"].map((key) => getCachedMarkdown(key)?.raw)).toEqual(["a", "d", "e"])
  })

  test("does not keep a block larger than the whole budget", () => {
    touchCachedMarkdown("huge", entry("huge", "x".repeat(markdownCacheBytes)))

    expect(getCachedMarkdown("huge")).toBeUndefined()
    expect(getCachedMarkdown("bytes:e")?.raw).toBe("e")
  })
})
