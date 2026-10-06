import { describe, expect, test } from "bun:test"
import { canEncodeQr, drawQrToCanvas, encodeQrMatrix } from "./phone-qr"

const URL = "http://192.168.1.42:4097/m"

describe("encodeQrMatrix", () => {
  test("encodes the launcher URL as a version 2 matrix", () => {
    const matrix = encodeQrMatrix(URL)
    expect(matrix.length).toBe(25)
    for (const row of matrix) expect(row.length).toBe(25)
  })

  test("pins finder, timing, and dark modules", () => {
    const matrix = encodeQrMatrix(URL)
    // Top-left finder: border dark, inner white ring, dark center.
    expect(matrix[0][0]).toBe(true)
    expect(matrix[0][6]).toBe(true)
    expect(matrix[6][0]).toBe(true)
    expect(matrix[1][1]).toBe(false)
    expect(matrix[3][3]).toBe(true)
    // Timing patterns alternate along row/column 6.
    expect(matrix[6][8]).toBe(true)
    expect(matrix[6][9]).toBe(false)
    expect(matrix[8][6]).toBe(true)
    // Fixed dark module above the bottom-left finder.
    expect(matrix[17][8]).toBe(true)
  })

  test("is deterministic", () => {
    expect(encodeQrMatrix(URL)).toEqual(encodeQrMatrix(URL))
  })
})

describe("canEncodeQr", () => {
  test("accepts the launcher URL and rejects overlong input", () => {
    expect(canEncodeQr(URL)).toBe(true)
    expect(canEncodeQr("x".repeat(79))).toBe(false)
  })
})

describe("drawQrToCanvas", () => {
  test("paints non-blank pixels", () => {
    const canvas = document.createElement("canvas")
    const rects: Array<readonly number[]> = []
    canvas.getContext = ((): CanvasRenderingContext2D => {
      return {
        fillRect: (...args: Array<number>) => {
          rects.push(args)
        },
      } as CanvasRenderingContext2D
    }) as unknown as typeof canvas.getContext
    drawQrToCanvas(canvas, URL)
    expect(canvas.width).toBeGreaterThan(0)
    expect(canvas.height).toBeGreaterThan(0)
    // One background fill plus one rect per dark module.
    expect(rects.length).toBeGreaterThan(1)
  })
})
