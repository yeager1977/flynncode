import { describe, expect, test } from "bun:test"
import {
  browserPaneUrlFor,
  clearBrowserPaneUrlsForTests,
  isLocalPreviewUrl,
  normalizePreviewUrl,
  setBrowserPaneUrl,
} from "./browser-pane"

describe("isLocalPreviewUrl", () => {
  test("accepts loopback http URLs", () => {
    expect(isLocalPreviewUrl("http://127.0.0.1:3000")).toBe(true)
    expect(isLocalPreviewUrl("http://localhost:5173/app")).toBe(true)
  })

  test("rejects non-local and non-http URLs", () => {
    expect(isLocalPreviewUrl("https://example.com")).toBe(false)
    expect(isLocalPreviewUrl("file:///etc/passwd")).toBe(false)
    expect(isLocalPreviewUrl("not a url")).toBe(false)
  })
})

describe("normalizePreviewUrl", () => {
  test("returns a parseable http URL and falls back otherwise", () => {
    expect(normalizePreviewUrl("127.0.0.1:3000", "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/")
    expect(normalizePreviewUrl("https://example.com/x", "http://127.0.0.1:3000")).toBe("https://example.com/x")
    expect(normalizePreviewUrl("file:///etc/passwd", "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
  })
})

describe("browserPaneUrlFor", () => {
  test("persists one URL per session key", () => {
    clearBrowserPaneUrlsForTests()
    expect(browserPaneUrlFor("ses_a", "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
    setBrowserPaneUrl("ses_a", "http://127.0.0.1:5173/app")
    setBrowserPaneUrl("ses_b", "http://localhost:4000")
    expect(browserPaneUrlFor("ses_a", "http://127.0.0.1:3000")).toBe("http://127.0.0.1:5173/app")
    expect(browserPaneUrlFor("ses_b", "http://127.0.0.1:3000")).toBe("http://localhost:4000")
    clearBrowserPaneUrlsForTests()
  })
})
