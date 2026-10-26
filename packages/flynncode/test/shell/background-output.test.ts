import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { BackgroundOutput } from "../../src/shell/background/output"
import { tmpdir } from "../fixture/fixture"

const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `l${String(from + i).padStart(4, "0")}....\n`)

describe("BackgroundOutput", () => {
  test("reads from logical offsets and persists to the file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    await fs.writeFile(file, "stale content from an earlier shell\n")
    const writer = BackgroundOutput.open(file)
    writer.write("hello\n")
    writer.write("wörld\n")
    const size = Buffer.byteLength("hello\nwörld\n")
    expect(writer.total()).toBe(size)
    expect(writer.readSince(0)).toEqual({ text: "hello\nwörld\n", offset: size, skipped: 0 })
    expect(writer.readSince(size)).toEqual({ text: "", offset: size, skipped: 0 })
    writer.write("next\n")
    expect(writer.readSince(size).text).toBe("next\n")
    await writer.close()
    expect(writer.truncated()).toBe(false)
    expect(await Bun.file(file).text()).toBe("hello\nwörld\nnext\n")
    // The window stays readable after close.
    expect(writer.readSince(0).text).toBe("hello\nwörld\nnext\n")
  })

  test("logical offsets keep working after the file cap is hit", async () => {
    await using tmp = await tmpdir()
    const writer = BackgroundOutput.open(path.join(tmp.path, "out.txt"), {
      capBytes: 1000,
      headBytes: 200,
      windowBytes: 500,
    })
    lines(0, 50).forEach((line) => writer.write(line))
    const first = writer.readSince(0)
    expect(first).toEqual({ text: lines(0, 50).join(""), offset: 500, skipped: 0 })

    lines(50, 20).forEach((line) => writer.write(line))
    const caught = writer.readSince(first.offset)
    expect(caught).toEqual({ text: lines(50, 20).join(""), offset: 700, skipped: 0 })

    lines(70, 300).forEach((line) => writer.write(line))
    expect(writer.truncated()).toBe(true)
    const behind = writer.readSince(caught.offset)
    expect(behind.skipped).toBe(3700 - 500 - 700)
    expect(behind.text).toBe(`...[2500 bytes skipped]...\n${lines(320, 50).join("")}`)
    expect(behind.offset).toBe(3700)

    lines(370, 3).forEach((line) => writer.write(line))
    expect(writer.readSince(behind.offset)).toEqual({ text: lines(370, 3).join(""), offset: 3730, skipped: 0 })
    await writer.close()
  })

  test("filter keeps matching lines, advances the offset, and prefixes skips only with text", async () => {
    await using tmp = await tmpdir()
    const writer = BackgroundOutput.open(path.join(tmp.path, "out.txt"), { windowBytes: 40 })
    writer.write("alpha\nERROR one\nbeta\nERROR two\n")
    const read = writer.readSince(0, { filter: /ERROR/g })
    expect(read).toEqual({ text: "ERROR one\nERROR two\n", offset: 31, skipped: 0 })

    writer.write("x".repeat(40) + "\n" + "quiet\n")
    const none = writer.readSince(read.offset, { filter: /ERROR/ })
    expect(none.text).toBe("")
    expect(none.skipped).toBeGreaterThan(0)
    expect(none.offset).toBe(writer.total())

    writer.write("y".repeat(40) + "\n" + "ERROR three\n")
    const some = writer.readSince(none.offset, { filter: /ERROR/ })
    expect(some.text).toMatch(/^\.\.\.\[\d+ bytes skipped\]\.\.\.\nERROR three\n$/)
    await writer.close()
  })

  test("maxBytes keeps the newest bytes and counts the rest as skipped", async () => {
    await using tmp = await tmpdir()
    const writer = BackgroundOutput.open(path.join(tmp.path, "out.txt"))
    writer.write("a".repeat(100) + "TAIL")
    const read = writer.readSince(0, { maxBytes: 10 })
    expect(read).toEqual({ text: "...[94 bytes skipped]...\naaaaaaTAIL", offset: 104, skipped: 94 })
    await writer.close()
  })

  test("a clipped read never starts mid-character", async () => {
    await using tmp = await tmpdir()
    const writer = BackgroundOutput.open(path.join(tmp.path, "out.txt"), { windowBytes: 31 })
    writer.write("€€€€€")
    const clipped = writer.readSince(0, { maxBytes: 10 })
    expect(clipped).toEqual({ text: "...[6 bytes skipped]...\n€€€", offset: 15, skipped: 6 })

    Array.from({ length: 20 }, () => writer.write("€"))
    const windowed = writer.readSince(0)
    expect(windowed.text).not.toContain("�")
    expect(windowed.skipped + Buffer.byteLength(windowed.text.split("\n")[1])).toBe(writer.total())
    expect(writer.lastLines(1)).not.toContain("�")
    await writer.close()
  })

  test("a filtered read never loses a match split across reads", async () => {
    await using tmp = await tmpdir()
    const writer = BackgroundOutput.open(path.join(tmp.path, "out.txt"))
    writer.write("ERR")
    const first = writer.readSince(0, { filter: /ERROR/ })
    expect(first).toEqual({ text: "", offset: 0, skipped: 0 })
    writer.write("OR boom\nnext ERR")
    const second = writer.readSince(first.offset, { filter: /ERROR/ })
    expect(second).toEqual({ text: "ERROR boom\n", offset: 11, skipped: 0 })
    // Unfiltered reads always consume everything.
    expect(writer.readSince(11).offset).toBe(writer.total())
    await writer.close()
    // Once the writer is closed the partial last line is final and is included.
    expect(writer.readSince(11, { filter: /ERR/ })).toEqual({ text: "next ERR", offset: writer.total(), skipped: 0 })
  })

  test("the filter applies to the whole range before maxBytes clips it", async () => {
    await using tmp = await tmpdir()
    const writer = BackgroundOutput.open(path.join(tmp.path, "out.txt"))
    writer.write("ERROR keep\n" + "noise noise noise\n".repeat(20))
    expect(writer.readSince(0, { filter: /ERROR/, maxBytes: 12 })).toEqual({ text: "ERROR keep\n", offset: writer.total(), skipped: 0 })
    await writer.close()
  })

  test("readSince ignores invalid offsets and byte limits", async () => {
    await using tmp = await tmpdir()
    const writer = BackgroundOutput.open(path.join(tmp.path, "out.txt"))
    writer.write("hello\n")
    const expected = { text: "hello\n", offset: 6, skipped: 0 }
    expect(writer.readSince(-5)).toEqual(expected)
    expect(writer.readSince(Number.NaN)).toEqual(expected)
    expect(writer.readSince(0, { maxBytes: 0 })).toEqual(expected)
    expect(writer.readSince(0, { maxBytes: -1 })).toEqual(expected)
    expect(writer.readSince(0, { maxBytes: Number.NaN })).toEqual(expected)
    await writer.close()
  })

  test("the file head ends on a character boundary", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file, { capBytes: 1000, headBytes: 200 })
    Array.from({ length: 700 }, () => writer.write("€"))
    await writer.close()
    const content = await Bun.file(file).arrayBuffer().then((buffer) => Buffer.from(buffer))
    const text = content.toString()
    expect(text).not.toContain("�")
    const [head, tail] = text.split(/\n\.\.\.\[output truncated[^\n]*\n/)
    expect(Buffer.byteLength(head)).toBe(198)
    const dropped = Number(text.match(/truncated: (\d+) bytes/)?.[1])
    expect(Buffer.byteLength(head) + dropped + Buffer.byteLength(tail)).toBe(writer.total())
    expect(writer.total()).toBe(2100)
  })

  test("a failed rewrite is retried by the trailing timer", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    // A non-empty directory in place of the temp file makes the first rewrite fail.
    await fs.mkdir(`${file}.tmp`)
    await fs.writeFile(path.join(`${file}.tmp`, "block"), "x")
    const writer = BackgroundOutput.open(file, { capBytes: 1000, headBytes: 200, flushMs: 100 })
    writer.write("x".repeat(2000))
    await Bun.sleep(30)
    expect(await Bun.file(file).text()).not.toContain("output truncated")
    await fs.rm(`${file}.tmp`, { recursive: true })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !(await Bun.file(file).text()).includes("output truncated")) await Bun.sleep(25)
    expect(await Bun.file(file).text()).toContain("output truncated")
    await writer.close()
  })

  test("lastLines returns the final lines from the window", async () => {
    await using tmp = await tmpdir()
    const writer = BackgroundOutput.open(path.join(tmp.path, "out.txt"))
    Array.from({ length: 100 }, (_, i) => writer.write(`line ${i}\n`))
    expect(writer.lastLines(20).split("\n")).toEqual(Array.from({ length: 20 }, (_, i) => `line ${80 + i}`))
    expect(writer.lastLines(500)).toContain("line 0\n")
    expect(writer.lastLines(0)).toBe("")
    expect(writer.lastLines(-3)).toBe("")
    await writer.close()
  })

  test("caps the file at head + marker + tail", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file, { capBytes: 1000, headBytes: 200 })
    const written = lines(0, 500)
    written.forEach((line) => writer.write(line))
    expect(writer.truncated()).toBe(true)
    // Synchronous writes never queue more than the cap for the disk.
    expect(writer.pendingBytes()).toBeLessThanOrEqual(1000)
    await writer.close()
    expect(writer.total()).toBe(5000)

    const text = await Bun.file(file).text()
    const all = written.join("")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1100)
    expect(text.startsWith(all.slice(0, 200))).toBe(true)
    expect(text).toMatch(/\n\.\.\.\[output truncated: \d+ bytes dropped\]\.\.\.\n/)
    const tail = text.split(/\.\.\.\[output truncated[^\n]*\n/)[1]
    expect(all.endsWith(tail)).toBe(true)
    expect(tail.length).toBeGreaterThan(700)
    expect(Number(text.match(/truncated: (\d+) bytes/)?.[1])).toBe(5000 - 200 - Buffer.byteLength(tail))
  })

  test("caps a file whose output crossed the cap after it was on disk", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file, { capBytes: 1000, headBytes: 200 })
    const written = lines(0, 300)
    await written.reduce(async (previous, line) => {
      await previous
      writer.write(line)
      await Bun.sleep(0)
    }, Promise.resolve())
    await writer.close()
    const text = await Bun.file(file).text()
    const all = written.join("")
    const tail = text.split(/\.\.\.\[output truncated[^\n]*\n/)[1]
    expect(text.startsWith(all.slice(0, 200))).toBe(true)
    expect(all.endsWith(tail)).toBe(true)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1100)
    expect(Number(text.match(/truncated: (\d+) bytes/)?.[1])).toBe(3000 - 200 - Buffer.byteLength(tail))
  })

  test("caps a single oversized write without splitting characters", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file, { capBytes: 1000, headBytes: 200 })
    writer.write("h".repeat(200) + "m".repeat(4600) + "t".repeat(200))
    await writer.close()
    const text = await Bun.file(file).text()
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1100)
    expect(text.startsWith("h".repeat(200))).toBe(true)
    expect(text.endsWith("t".repeat(200))).toBe(true)

    const euro = path.join(tmp.path, "euro.txt")
    const other = BackgroundOutput.open(euro, { capBytes: 1000, headBytes: 201 })
    Array.from({ length: 600 }, () => other.write("€€€"))
    await other.close()
    const content = await Bun.file(euro).text()
    expect(content).not.toContain("�")
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(1100)
  })

  test("rewrites are atomic: readers never see an empty or partial file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    // Multi-megabyte rewrites make a truncate-then-write window wide enough to observe.
    const writer = BackgroundOutput.open(file, { capBytes: 8 * 1024 * 1024, headBytes: 1000, flushMs: 0 })
    writer.write("h".repeat(1000) + "x".repeat(8 * 1024 * 1024))
    await Bun.sleep(50)
    expect(await Bun.file(file).text()).toContain("output truncated")

    const deadline = Date.now() + 1000
    const producer = (async () => {
      for (let i = 0; Date.now() < deadline; i++) {
        writer.write(`row ${i} ${"y".repeat(64 * 1024)}\n`)
        await Bun.sleep(1)
      }
    })()
    const observed: number[] = []
    while (Date.now() < deadline) {
      // A synchronous read runs on this thread while the rewrite runs on a worker thread.
      const content = readFileSync(file)
      observed.push(content.length)
      expect(content.subarray(0, 1000).toString()).toBe("h".repeat(1000))
      expect(content.subarray(1000, 1100).toString()).toContain("output truncated")
      // A full rewrite is head + marker + a full tail, so anything shorter is a partial file.
      expect(content.length).toBeGreaterThan(8 * 1024 * 1024)
      // An in-place rewrite would mix old and new bytes, breaking the run of consecutive rows.
      const rows = Array.from(content.toString().matchAll(/row (\d+) /g), (match) => Number(match[1]))
      expect(rows.every((row, i) => i === 0 || row === rows[i - 1] + 1)).toBe(true)
      await Bun.sleep(0)
    }
    await producer
    await writer.close()
    expect(observed.length).toBeGreaterThan(10)
    expect(await fs.readdir(tmp.path)).toEqual(["out.txt"])
  })

  test("a trailing timer flushes a quiet burst to the file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "out.txt")
    const writer = BackgroundOutput.open(file, { capBytes: 1000, headBytes: 200, flushMs: 300 })
    writer.write("x".repeat(2000))
    await Bun.sleep(50)
    expect(await Bun.file(file).text()).toContain("output truncated")

    writer.write("QUIET BURST END\n")
    await Bun.sleep(50)
    expect(await Bun.file(file).text()).not.toContain("QUIET BURST END")
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !(await Bun.file(file).text()).endsWith("QUIET BURST END\n")) await Bun.sleep(25)
    expect(await Bun.file(file).text()).toEndWith("QUIET BURST END\n")
    await writer.close()
  })

  test("a failing disk keeps pending memory bounded and never throws", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "readonly")
    await fs.mkdir(dir)
    await fs.chmod(dir, 0o500)
    try {
      const writer = BackgroundOutput.open(path.join(dir, "out.txt"), { capBytes: 1000, headBytes: 200 })
      Array.from({ length: 50 }, () => lines(0, 100).forEach((line) => writer.write(line)))
      expect(writer.pendingBytes()).toBeLessThanOrEqual(1000)
      await Bun.sleep(20)
      expect(writer.pendingBytes()).toBeLessThanOrEqual(1000)
      expect(writer.total()).toBe(50_000)
      expect(writer.lastLines(1)).toBe(lines(99, 1)[0].trimEnd())
      await writer.close()
      expect(writer.pendingBytes()).toBe(0)
      expect(await fs.readdir(dir)).toEqual([])
    } finally {
      await fs.chmod(dir, 0o700)
    }
  })
})
