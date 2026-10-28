import { describe, expect, test } from "bun:test"
import { ansiCubeRgb, ansiPlainText, parseAnsi } from "@flynncode/ui/theme/ansi"
import { ansiCssColor } from "@/components/session/session-status-line-color"
import { createStatusLineSource, statusLineVisible } from "@/hooks/use-session-statusline"

const ESC = "\u001b"

describe("parseAnsi", () => {
  test("plain text is a single unstyled run", () => {
    expect(parseAnsi("main  3 files")).toEqual([{ text: "main  3 files", bold: false, dim: false }])
  })

  test("16-colour foregrounds map to palette indexes, bright ones to 8-15", () => {
    expect(parseAnsi(`${ESC}[31mred${ESC}[0m ${ESC}[92mlime${ESC}[0m`)).toEqual([
      { text: "red", fg: 1, bold: false, dim: false },
      { text: " ", bold: false, dim: false },
      { text: "lime", fg: 10, bold: false, dim: false },
    ])
  })

  test("256-colour and truecolour foregrounds", () => {
    expect(parseAnsi(`${ESC}[38;5;208mo${ESC}[38;2;1;2;3mt`)).toEqual([
      { text: "o", fg: 208, bold: false, dim: false },
      { text: "t", fg: { r: 1, g: 2, b: 3 }, bold: false, dim: false },
    ])
  })

  test("bold, dim, their shared off code and reset", () => {
    expect(parseAnsi(`${ESC}[1mB${ESC}[2mD${ESC}[22mN${ESC}[1;32mG${ESC}[mR`)).toEqual([
      { text: "B", bold: true, dim: false },
      { text: "D", bold: true, dim: true },
      { text: "N", bold: false, dim: false },
      { text: "G", fg: 2, bold: true, dim: false },
      { text: "R", bold: false, dim: false },
    ])
  })

  test("39 returns to the default colour and keeps other attributes", () => {
    expect(parseAnsi(`${ESC}[1;34mA${ESC}[39mB`)).toEqual([
      { text: "A", fg: 4, bold: true, dim: false },
      { text: "B", bold: true, dim: false },
    ])
  })

  test("other escapes are stripped and never leak into the text", () => {
    const line = `${ESC}[2K${ESC}[1;5H${ESC}]0;title\u0007${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\${ESC}[4munder\u0000`
    expect(ansiPlainText(line)).toBe("linkunder")
    expect(parseAnsi(line).map((run) => run.text)).toEqual(["linkunder"])
  })

  test("an unknown SGR code is ignored without dropping the text", () => {
    expect(parseAnsi(`${ESC}[7;33mhi`)).toEqual([{ text: "hi", fg: 3, bold: false, dim: false }])
  })

  test("a truncated escape at the end of the line is dropped", () => {
    expect(ansiPlainText(`ok${ESC}[3`)).toBe("ok")
    expect(ansiPlainText(`ok${ESC}`)).toBe("ok")
  })

  test("the colour cube and grey ramp match xterm", () => {
    expect(ansiCubeRgb(16)).toEqual({ r: 0, g: 0, b: 0 })
    expect(ansiCubeRgb(196)).toEqual({ r: 255, g: 0, b: 0 })
    expect(ansiCubeRgb(231)).toEqual({ r: 255, g: 255, b: 255 })
    expect(ansiCubeRgb(232)).toEqual({ r: 8, g: 8, b: 8 })
    expect(ansiCubeRgb(255)).toEqual({ r: 238, g: 238, b: 238 })
  })
})

describe("ansiCssColor", () => {
  test("base colours use the theme variables, the cube and truecolour use literal rgb", () => {
    expect(ansiCssColor(1)).toBe("var(--status-line-ansi-1)")
    expect(ansiCssColor(15)).toBe("var(--status-line-ansi-15)")
    expect(ansiCssColor(196)).toBe("rgb(255 0 0)")
    expect(ansiCssColor({ r: 1, g: 2, b: 3 })).toBe("rgb(1 2 3)")
  })
})

describe("statusLineVisible", () => {
  test("hidden for no lines and for lines with nothing to show", () => {
    expect(statusLineVisible([])).toBe(false)
    expect(statusLineVisible(["", "   "])).toBe(false)
    expect(statusLineVisible([`${ESC}[31m${ESC}[0m`])).toBe(false)
  })

  test("shown as soon as one line has visible text", () => {
    expect(statusLineVisible(["main"])).toBe(true)
    expect(statusLineVisible(["", `${ESC}[32mok${ESC}[0m`])).toBe(true)
  })
})

describe("createStatusLineSource", () => {
  const setup = () => {
    const seen: string[][] = []
    const source = createStatusLineSource((lines) => seen.push(lines))
    return { seen, source }
  }

  test("a fetch applies its lines", async () => {
    const { seen, source } = setup()
    await source.fetch(async () => ["a"])
    expect(seen).toEqual([["a"]])
  })

  test("a failed or empty fetch applies nothing", async () => {
    const { seen, source } = setup()
    await source.fetch(async () => undefined)
    await source.fetch(async () => {
      throw new Error("offline")
    })
    expect(seen).toEqual([])
  })

  test("an event that lands while a fetch is in flight wins over the older fetch", async () => {
    const { seen, source } = setup()
    const gate = Promise.withResolvers<string[]>()
    const pending = source.fetch(() => gate.promise)
    source.push(["fresh"])
    gate.resolve(["stale"])
    await pending
    expect(seen).toEqual([["fresh"]])
  })

  test("a reset clears the lines and discards a fetch from the previous session", async () => {
    const { seen, source } = setup()
    const gate = Promise.withResolvers<string[]>()
    const pending = source.fetch(() => gate.promise)
    source.reset()
    gate.resolve(["other session"])
    await pending
    expect(seen).toEqual([[]])
  })
})
