import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { isHostable, parsePreviewRect, sanitizeElement } from "./preview-host"

describe("isHostable", () => {
  test("preview host accepts only local preview urls", () => {
    expect(isHostable("http://127.0.0.1:3000/app")).toBe(true)
    expect(isHostable("https://example.com")).toBe(false)
    expect(isHostable("file:///etc/passwd")).toBe(false)
  })

  test("loopback hostnames pass, public and non-http schemes fail", () => {
    expect(isHostable("http://localhost:5173")).toBe(true)
    expect(isHostable("http://[::1]:4000")).toBe(true)
    expect(isHostable("http://web.localhost:3000")).toBe(true)
    expect(isHostable("http://10.0.0.2:3000")).toBe(false)
    expect(isHostable("ftp://localhost:21")).toBe(false)
    expect(isHostable("not a url")).toBe(false)
  })

  test("128-bit-adjacent hostnames loop back through 127/8 only", () => {
    expect(isHostable("http://127.9.9.9:3000")).toBe(true)
    expect(isHostable("http://10.127.0.1:3000")).toBe(false)
  })

  test("mDNS *.local is refused: it can resolve to LAN hosts", () => {
    expect(isHostable("http://foo.local:3000")).toBe(false)
    expect(isHostable("https://printer.local/app")).toBe(false)
    expect(isHostable("http://localhost.local/app")).toBe(false)
  })
})

describe("parsePreviewRect", () => {
  test("converts renderer CSS pixels to DIPs with the zoom factor", () => {
    expect(parsePreviewRect({ x: 10, y: 20.4, width: 100, height: 50 }, 2)).toEqual({
      x: 20,
      y: 41,
      width: 200,
      height: 100,
    })
  })

  test("refuses non-finite or missing geometry", () => {
    expect(parsePreviewRect(undefined, 1)).toBeUndefined()
    expect(parsePreviewRect("rect", 1)).toBeUndefined()
    expect(parsePreviewRect({ x: 0, y: Number.NaN, width: 10, height: 10 }, 1)).toBeUndefined()
    expect(parsePreviewRect({ x: 0, y: 0 }, 1)).toBeUndefined()
  })

  test("clamps negatives and permits zero size so the view can be hidden", () => {
    expect(parsePreviewRect({ x: -5, y: 0, width: -10, height: 0 }, 1)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  test("caps runaway geometry", () => {
    const rect = parsePreviewRect({ x: 1e12, y: 0, width: 1e12, height: 10 }, 1)
    expect(rect).toEqual({ x: 1_000_000, y: 0, width: 1_000_000, height: 10 })
  })
})

describe("sanitizeElement", () => {
  test("element payload is clamped and sanitized", () => {
    const el = sanitizeElement({
      tag: "BUTTON",
      id: "x",
      classes: "a b",
      text: "  Save file  ",
      rect: { x: -5, y: 999999, width: 10, height: 10 },
    })!
    expect(el.text.length).toBeLessThanOrEqual(200)
    expect(el.text).toBe("Save file")
    expect(el.rect.y).toBeGreaterThanOrEqual(0)
    expect(el.rect.x).toBe(0)
    expect(el.tag).toBe("BUTTON")
  })

  test("truncates unbounded text and long identifiers", () => {
    const el = sanitizeElement({
      tag: "DIV",
      id: "i".repeat(500),
      classes: "c".repeat(500),
      text: "t".repeat(500),
      rect: { x: 0, y: 0, width: 10, height: 10 },
    })!
    expect(el.text?.length).toBe(200)
    expect(el.id?.length).toBe(200)
    expect(el.classes?.length).toBe(200)
  })

  test("requires a tag and valid rect geometry", () => {
    expect(sanitizeElement(undefined)).toBeUndefined()
    expect(sanitizeElement({ rect: { x: 0, y: 0, width: 1, height: 1 } })).toBeUndefined()
    expect(sanitizeElement({ tag: "DIV", rect: { x: 0, y: "zero", width: 1, height: 1 } })).toBeUndefined()
  })

  test("drops empty optional fields", () => {
    const el = sanitizeElement({
      tag: "BODY",
      id: "  ",
      classes: "",
      text: "",
      rect: { x: 1, y: 2, width: 3, height: 4 },
    })!
    expect(el).toEqual({ tag: "BODY", rect: { x: 1, y: 2, width: 3, height: 4 } })
  })
})

describe("preview-host renderer-hide lifecycle", () => {
  const source = readFileSync(new URL("./preview-host.ts", import.meta.url), "utf8")

  const fnSource = (start: string, end: string) => {
    const from = source.indexOf(start)
    const to = source.indexOf(end, from + 1)
    if (from === -1 || to === -1) throw new Error(`marker not found: ${start}`)
    return source.slice(from, to)
  }

  test("a fresh attach clears a stale renderer-hide so ownership bounds can reveal it", () => {
    const attach = fnSource("export async function attachView", "export function setViewBounds")
    expect(attach).toContain("hiddenByRenderer.delete(win)")
    expect(attach.indexOf("hiddenByRenderer.delete(win)")).toBeLessThan(attach.indexOf("new WebContentsView"))
  })

  test("detaching the view clears its renderer-hide flag", () => {
    const detach = fnSource("export function detachView", "export async function captureView")
    expect(detach).toContain("hiddenByRenderer.delete(win)")
  })

  test("bounds refreshes still honor an active renderer-hide", () => {
    expect(source).toContain("if (hiddenByRenderer.get(win) === true) return")
  })
})

describe("preview-host ipc surface", () => {
  const ipcSource = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8")

  test("attach handler re-validates hostability in the main process", () => {
    expect(ipcSource).toContain('"preview-host:attach"')
    expect(ipcSource).toContain("isHostable(url)")
  })
})
