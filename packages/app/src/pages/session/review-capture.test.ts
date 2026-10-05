import { describe, expect, test } from "bun:test"
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
