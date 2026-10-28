/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { StatusLineRows } from "../../src/routes/session/status-line"
import { createStatusLineSource, statusLineChunks } from "../../src/util/status-line"

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

  test("strips other escapes, C1 controls and bidi overrides", () => {
    expect(statusLineChunks(`${ESC}[2Kplain${ESC}]0;t\u0007`).map((chunk) => chunk.text)).toEqual(["plain"])
    expect(statusLineChunks("a\u009b2Jb\u202ec").map((chunk) => chunk.text)).toEqual(["abc"])
  })

  test("maps backgrounds, including truecolour operands that must not read as codes", () => {
    const chunks = statusLineChunks(`${ESC}[48;2;10;20;30mA${ESC}[44mB${ESC}[48;5;196mC${ESC}[49mD`)
    expect(chunks.map((chunk) => chunk.text)).toEqual(["A", "B", "C", "D"])
    expect(chunks[0].bg?.toInts()).toEqual([10, 20, 30, 255])
    expect(chunks[0].fg).toBeUndefined()
    expect(chunks[0].attributes).toBe(0)
    expect(chunks[1].bg?.toInts()).toEqual([0, 0, 128, 255])
    expect(chunks[2].bg?.toInts()).toEqual([255, 0, 0, 255])
    expect(chunks[3].bg).toBeUndefined()
  })
})

describe("createStatusLineSource", () => {
  test("a GET result applies unless an event or a session switch came after it started", async () => {
    const seen: string[][] = []
    const source = createStatusLineSource((lines) => seen.push(lines))
    await source.fetch(async () => ["fetched"])
    const slow = Promise.withResolvers<string[]>()
    const pending = source.fetch(() => slow.promise)
    source.push(["event"])
    slow.resolve(["stale"])
    await pending
    // A GET that clears the lines (config removed) replaces what an earlier event showed.
    await source.fetch(async () => [])
    expect(seen).toEqual([["fetched"], ["event"], []])
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
