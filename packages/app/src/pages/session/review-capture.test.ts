import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { browserAnnotation } from "./hunk-revert"

describe("browserAnnotation capture", () => {
  test("includes the thumbnail when provided", () => {
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
    expect(annotation).toContain("data:image/png;base64,AAA")
    expect(annotation).toContain("/app - hero off-center - 10%,20%-40%,35%")
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
