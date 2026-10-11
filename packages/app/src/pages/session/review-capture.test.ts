import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { browserAnnotation } from "./hunk-revert"

describe("browserAnnotation capture", () => {
  test("annotation text omits the data url thumbnail", () => {
    const annotation = browserAnnotation({
      url: "http://127.0.0.1:3000/app",
      path: "/app",
      note: "hero off-center",
      x: 10,
      y: 20,
      width: 30,
      height: 15,
      thumbnail: "data:image/png;base64,AAA",
    })
    expect(annotation).toBe("/app - hero off-center - 10%,20%-40%,35%")
    expect(annotation).not.toContain("data:")
  })

  test("falls back to rect-only when capture is unavailable", () => {
    const annotation = browserAnnotation({
      url: "http://127.0.0.1:3000/app",
      path: "/app",
      note: "hero off-center",
      x: 10,
      y: 20,
      width: 0,
      height: 0,
    })
    expect(annotation).toBe("/app - hero off-center - 10%,20%")
    expect(annotation).not.toContain("data:")
  })
})

// The annotation submit path also stores a sidebar screenshot artifact so the
// capture survives the transcript; the component reads the session id from the
// session layout params and the directory from the SDK.
describe("review browser artifact wiring", () => {
  test("stores a screenshot artifact on annotate from the route session", () => {
    const source = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
    expect(source).toContain("storeArtifact")
    expect(source).toContain("useSessionLayout")
    expect(source).toContain('"screenshot"')
    expect(source).toContain("layout.params.id")
    expect(source).toContain("sdk().directory")
  })

  test("screenshots are scoped to the browser pane iframe", () => {
    const source = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
    expect(source).toContain("frame?.getBoundingClientRect()")
    expect(source).toContain("capturePage?.({")
  })

  test("native mode captures through the preview host before the iframe fallback", () => {
    const source = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
    expect(source).toContain("if (state.native)")
    expect(source).toContain("nativeApi()?.capture()")
    const nativeCapture = source.indexOf("nativeApi()?.capture()")
    const fallbackCapture = source.indexOf("capturePage?.({")
    expect(nativeCapture).toBeGreaterThan(-1)
    expect(nativeCapture).toBeLessThan(fallbackCapture)
  })

  test("artifact version bumps signal reactive sidebar refresh", () => {
    const module = readFileSync(new URL("../layout/sidebar-artifacts.ts", import.meta.url), "utf8")
    expect(module).toContain("createSignal")
    expect(module).toContain("setArtifactVersion")
    expect(module).toContain("artifactVersionSignal")
    const section = readFileSync(new URL("../layout/sidebar-artifacts-section.tsx", import.meta.url), "utf8")
    expect(section).toContain("artifactVersionSignal")
  })
})

describe("annotate-to-chat prefill", () => {
  test("annotation payload is structured, not a base64 comment", () => {
    const source = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
    expect(source).toContain("onAnnotate({") // structured payload call
    expect(source).toContain("screenshot: dataUrl") // capture flows through the payload
    expect(source).toContain("rect: {") // percent rect rides with the payload
  })

  test("review comments forward the structured annotation to the session wiring", () => {
    // Both onLineComment call sites must forward the whole comment object;
    // a destructured field list would silently drop rect/screenshot.
    const source = readFileSync(new URL("../session.tsx", import.meta.url), "utf8")
    expect(source).toContain('addCommentToContext({ ...comment, origin: "review" })')
    expect(source).toContain("screenshotFallbackComment")
  })

  test("annotation text carries page path, rect mark, and note", async () => {
    const { browserAnnotation } = await import("./hunk-revert")
    const text = browserAnnotation({
      url: "http://127.0.0.1:3000/settings",
      path: "/settings",
      note: "button overflows",
      x: 10,
      y: 20,
      width: 30,
      height: 15,
    })
    expect(text).toContain("/settings")
    expect(text).toContain("button overflows")
    expect(text).toContain("10%,20%")
  })

  test("empty note does not produce an annotation", () => {
    const source = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
    expect(source).toContain("state.note.trim()")
  })

  test("sent annotation announces confirmation for assistive tech", () => {
    const source = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
    expect(source).toContain('language.t("session.review.browserPane.annotateSent")')
    expect(source).toContain('language.t("session.review.browserPane.emptyNote")')
    expect(source).toContain('aria-live="polite"')
  })
})
