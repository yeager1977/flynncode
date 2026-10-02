import { describe, expect, test } from "bun:test"
import { artifactMime, artifactPreviewKind, artifactText } from "./artifact-preview"

describe("artifactPreviewKind", () => {
  test("classifies html, markdown, and images", () => {
    expect(artifactPreviewKind("notes/page.HTML")).toBe("html")
    expect(artifactPreviewKind("docs/readme.md")).toBe("markdown")
    expect(artifactPreviewKind("shots/hero.png")).toBe("image")
    expect(artifactPreviewKind("src/app.ts")).toBeUndefined()
  })
})

describe("artifactMime", () => {
  test("uses the file extension", () => {
    expect(artifactMime("a.webp")).toBe("image/webp")
    expect(artifactMime("a.md")).toBe("text/markdown")
  })
})

describe("artifactText", () => {
  test("decodes base64 text and leaves plain text alone", () => {
    expect(artifactText("hello")).toBe("hello")
    expect(artifactText(btoa("hello"), "base64")).toBe("hello")
  })
})
