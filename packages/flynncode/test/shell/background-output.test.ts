import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { BackgroundOutput } from "../../src/shell/background/output"
import { tmpdir } from "../fixture/fixture"

describe("BackgroundOutput", () => {
  test("round-trips writes with offsets", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file)
    writer.write("hello\n")
    writer.write("wörld\n")
    await writer.close()
    expect(writer.bytes()).toBe(Buffer.byteLength("hello\nwörld\n"))
    expect(writer.truncated()).toBe(false)

    const first = await BackgroundOutput.readSince(file, 0)
    expect(first.text).toBe("hello\nwörld\n")
    expect(first.offset).toBe(Buffer.byteLength("hello\nwörld\n"))

    const again = await BackgroundOutput.readSince(file, first.offset)
    expect(again).toEqual({ text: "", offset: first.offset })

    const more = BackgroundOutput.open(file)
    more.write("next\n")
    await more.close()
    const next = await BackgroundOutput.readSince(file, first.offset)
    expect(next.text).toBe("next\n")
  })

  test("filter returns matching lines but advances the offset fully", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file)
    writer.write("alpha\nERROR one\nbeta\nERROR two\n")
    await writer.close()
    const read = await BackgroundOutput.readSince(file, 0, { filter: /ERROR/g })
    expect(read.text).toBe("ERROR one\nERROR two\n")
    expect(read.offset).toBe(Buffer.byteLength("alpha\nERROR one\nbeta\nERROR two\n"))
  })

  test("clips to the newest bytes when over maxBytes", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file)
    writer.write("a".repeat(100) + "TAIL")
    await writer.close()
    const read = await BackgroundOutput.readSince(file, 0, { maxBytes: 10 })
    expect(read.text.startsWith("...[earlier output skipped]...")).toBe(true)
    expect(read.text.endsWith("aaaaaaTAIL")).toBe(true)
    expect(read.offset).toBe(104)
  })

  test("caps the file at head + marker + tail", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file, { capBytes: 1000, headBytes: 200 })
    const lines = Array.from({ length: 500 }, (_, i) => `l${String(i).padStart(3, "0")}.....\n`)
    lines.forEach((line) => writer.write(line))
    expect(writer.truncated()).toBe(true)
    await writer.close()
    expect(writer.bytes()).toBe(5000)

    const text = await Bun.file(file).text()
    const all = lines.join("")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1100)
    expect(text.startsWith(all.slice(0, 200))).toBe(true)
    expect(text).toMatch(/\n\.\.\.\[output truncated: \d+ bytes dropped\]\.\.\.\n/)
    expect(text.endsWith(all.slice(-100))).toBe(true)
    const dropped = Number(text.match(/truncated: (\d+) bytes/)?.[1])
    expect(dropped).toBe(5000 - 200 - Buffer.byteLength(text.split(/\.\.\.\[output truncated[^\n]*\n/)[1]))
  })

  test("caps a single oversized write", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file, { capBytes: 1000, headBytes: 200 })
    writer.write("h".repeat(200) + "m".repeat(4600) + "t".repeat(200))
    await writer.close()
    const text = await Bun.file(file).text()
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1100)
    expect(text.startsWith("h".repeat(200))).toBe(true)
    expect(text.endsWith("t".repeat(200))).toBe(true)
  })

  test("truncation never splits a multi-byte character", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file, { capBytes: 1000, headBytes: 201 })
    Array.from({ length: 600 }, () => writer.write("€€€"))
    await writer.close()
    const text = await Bun.file(file).text()
    expect(text).not.toContain("\uFFFD")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1100)
  })

  test("readSince restarts at 0 after the file was rewritten shorter", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file, { capBytes: 1000, headBytes: 200 })
    writer.write("x".repeat(900))
    await writer.close()
    const before = await BackgroundOutput.readSince(file, 0)
    expect(before.offset).toBe(900)

    await fs.writeFile(file, "short\n")
    const after = await BackgroundOutput.readSince(file, before.offset)
    expect(after.text).toBe("short\n")
    expect(after.offset).toBe(6)
  })

  test("lastLines returns the final lines", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file)
    Array.from({ length: 100 }, (_, i) => writer.write(`line ${i}\n`))
    await writer.close()
    const text = await BackgroundOutput.lastLines(file, 20)
    expect(text.split("\n")).toEqual(Array.from({ length: 20 }, (_, i) => `line ${80 + i}`))
    expect(await BackgroundOutput.lastLines(file, 500)).toContain("line 0\n")
    expect(await BackgroundOutput.lastLines(path.join(tmp.path, "missing"), 5)).toBe("")
  })
})
