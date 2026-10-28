/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { StatusLineRows } from "../../src/routes/session/status-line"
import { statusLineChunks } from "../../src/util/status-line"

const ESC = "\u001b"

describe("statusLineChunks", () => {
  test("maps colours to RGBA and bold/dim to text attributes", () => {
    const chunks = statusLineChunks(`${ESC}[1;31mfail${ESC}[0m ${ESC}[2mquiet${ESC}[38;5;196mred${ESC}[38;2;1;2;3mrgb`)
    expect(chunks.map((chunk) => chunk.text)).toEqual(["fail", " ", "quiet", "red", "rgb"])
    expect(chunks[0].attributes).toBe(TextAttributes.BOLD)
    expect(chunks[0].fg?.toInts()).toEqual([128, 0, 0, 255])
    expect(chunks[1].attributes).toBe(0)
    expect(chunks[1].fg).toBeUndefined()
    expect(chunks[2].attributes).toBe(TextAttributes.DIM)
    expect(chunks[3].attributes).toBe(TextAttributes.DIM)
    expect(chunks[3].fg?.toInts()).toEqual([255, 0, 0, 255])
    expect(chunks[4].fg?.toInts()).toEqual([1, 2, 3, 255])
  })

  test("strips other escapes", () => {
    expect(statusLineChunks(`${ESC}[2Kplain${ESC}]0;t\u0007`).map((chunk) => chunk.text)).toEqual(["plain"])
  })
})

describe("StatusLineRows", () => {
  test("renders each line as text without raw escape codes", async () => {
    const app = await testRender(
      () => (
        <StatusLineRows
          lines={[`${ESC}[32mmain${ESC}[0m  3 files`, `${ESC}[1mline two${ESC}[0m`]}
          fg={RGBA.fromInts(200, 200, 200)}
        />
      ),
      { width: 40, height: 4 },
    )
    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("main  3 files")
      expect(frame).toContain("line two")
      expect(frame).not.toContain("[32m")
    } finally {
      app.renderer.destroy()
    }
  })
})
