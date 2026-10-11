import { describe, expect, test } from "bun:test"
import { capturePrimaryScreen } from "./screen-capture"

describe("capturePrimaryScreen", () => {
  test("returns null when the capture source list is empty", async () => {
    const result = await capturePrimaryScreen({ getSources: async () => [] })
    expect(result).toBeNull()
  })

  test("returns a data url from the first non-empty thumbnail", async () => {
    const result = await capturePrimaryScreen({
      getSources: async () => [{ name: "screen", thumbnail: { toDataURL: () => "data:image/png;base64,AA" } }],
    })
    expect(result?.dataUrl).toBe("data:image/png;base64,AA")
  })

  test("returns null when getSources rejects", async () => {
    const result = await capturePrimaryScreen({
      getSources: async () => {
        throw new Error("capture denied")
      },
    })
    expect(result).toBeNull()
  })

  test("returns null when the capture times out", async () => {
    const result = await capturePrimaryScreen({
      getSources: () => new Promise(() => {}),
      timeoutMs: 10,
    })
    expect(result).toBeNull()
  })

  test("skips sources without thumbnails and requests a bounded thumbnail size", async () => {
    const sizes: { types?: string[]; thumbnailSize?: { width: number; height: number } }[] = []
    const result = await capturePrimaryScreen({
      getSources: async (options) => {
        sizes.push(options)
        return [
          { name: "screen 1" },
          { name: "screen 2", thumbnail: { toDataURL: () => "data:image/png;base64,AA" } },
        ]
      },
    })
    expect(result?.dataUrl).toBe("data:image/png;base64,AA")
    expect(sizes[0]?.types).toEqual(["screen"])
    expect(sizes[0]?.thumbnailSize.width).toBe(1920)
    expect(sizes[0]?.thumbnailSize.height).toBe(1920)
  })
})