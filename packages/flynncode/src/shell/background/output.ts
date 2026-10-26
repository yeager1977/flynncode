export * as BackgroundOutput from "./output"

import fs from "fs/promises"

const DEFAULT_CAP_BYTES = 50 * 1024 * 1024
const DEFAULT_HEAD_BYTES = 1024 * 1024
const DEFAULT_READ_BYTES = 50 * 1024
const REWRITE_INTERVAL_MS = 5_000
const SKIPPED_MARKER = "...[earlier output skipped]..."

export type Writer = {
  write(chunk: string): void
  close(): Promise<void>
  bytes(): number
  truncated(): boolean
}

export function open(file: string, input?: { capBytes?: number; headBytes?: number }): Writer {
  const capBytes = input?.capBytes ?? DEFAULT_CAP_BYTES
  const headBytes = Math.min(input?.headBytes ?? DEFAULT_HEAD_BYTES, capBytes)
  const tailCap = capBytes - headBytes

  // `total` counts every byte accepted (readable synchronously); `processed` counts only what the
  // chain has handled, so the marker's dropped count always matches what was written to the file.
  let total = 0
  let processed = 0
  let pending: Buffer[] = []
  let scheduled = false
  let chain = Promise.resolve()

  let onDisk = 0
  let rolling = false
  let head = Buffer.alloc(0)
  let tail: Buffer[] = []
  let tailBytes = 0
  let lastRewrite = 0

  async function flush() {
    scheduled = false
    const data = Buffer.concat(pending)
    pending = []
    processed += data.length
    if (!rolling) {
      if (onDisk + data.length <= capBytes) {
        await fs.appendFile(file, data)
        onDisk += data.length
        return
      }
      // Crossing the cap: everything so far is on disk, so split it into head and tail now.
      const all = Buffer.concat([onDisk === 0 ? Buffer.alloc(0) : await fs.readFile(file), data])
      head = all.subarray(0, headEnd(all, headBytes))
      tail = [all.subarray(head.length)]
      tailBytes = tail[0].length
      rolling = true
      trimTail()
      await rewrite()
      return
    }
    tail.push(data)
    tailBytes += data.length
    trimTail()
    if (Date.now() - lastRewrite >= REWRITE_INTERVAL_MS) await rewrite()
  }

  function trimTail() {
    while (tail.length > 1 && tailBytes - tail[0].length >= tailCap) tailBytes -= tail.shift()!.length
    if (tailBytes <= tailCap * 2) return
    tail = [tailOf(Buffer.concat(tail), tailCap)]
    tailBytes = tail[0].length
  }

  async function rewrite() {
    const kept = tailOf(Buffer.concat(tail), tailCap)
    const marker = Buffer.from(`\n...[output truncated: ${processed - head.length - kept.length} bytes dropped]...\n`)
    await fs.writeFile(file, Buffer.concat([head, marker, kept]))
    lastRewrite = Date.now()
  }

  return {
    write(chunk) {
      const data = Buffer.from(chunk)
      if (data.length === 0) return
      total += data.length
      pending.push(data)
      if (scheduled) return
      scheduled = true
      // A failed disk write must never break the shell producing the output.
      chain = chain.then(flush).catch(() => undefined)
    },
    async close() {
      await chain
      if (rolling) await rewrite().catch(() => undefined)
    },
    bytes: () => total,
    truncated: () => total > capBytes,
  }
}

export async function readSince(
  file: string,
  offset: number,
  input?: { filter?: RegExp; maxBytes?: number },
): Promise<{ text: string; offset: number }> {
  const maxBytes = input?.maxBytes ?? DEFAULT_READ_BYTES
  const handle = await fs.open(file, "r").catch(() => undefined)
  if (!handle) return { text: "", offset }
  try {
    const size = (await handle.stat()).size
    // The file shrinks when a capped writer rewrites it, so older offsets no longer apply.
    const from = size < offset ? 0 : offset
    const clipped = size - from > maxBytes
    const start = clipped ? size - maxBytes : from
    const buffer = Buffer.alloc(size - start)
    const read = (await handle.read(buffer, 0, buffer.length, start)).bytesRead
    // Leave a partially written trailing character for the next read.
    const usable = completeEnd(buffer.subarray(0, read))
    const text = filterLines(buffer.subarray(0, usable).toString("utf8"), input?.filter)
    return { text: clipped ? `${SKIPPED_MARKER}\n${text}` : text, offset: start + usable }
  } finally {
    await handle.close()
  }
}

export async function lastLines(file: string, count: number): Promise<string> {
  const handle = await fs.open(file, "r").catch(() => undefined)
  if (!handle) return ""
  try {
    const size = (await handle.stat()).size
    const block = 64 * 1024
    const chunks: Buffer[] = []
    const newlines = () => chunks.reduce((sum, chunk) => sum + chunk.filter((byte) => byte === 10).length, 0)
    // Walk backwards until there are enough line breaks (count lines plus the trailing one).
    for (let end = size; end > 0 && newlines() <= count; end -= block) {
      const start = Math.max(0, end - block)
      const buffer = Buffer.alloc(end - start)
      await handle.read(buffer, 0, buffer.length, start)
      chunks.unshift(buffer)
    }
    const lines = Buffer.concat(chunks).toString("utf8").replace(/\n$/, "").split("\n")
    return lines.slice(-count).join("\n")
  } finally {
    await handle.close()
  }
}

function filterLines(text: string, filter?: RegExp) {
  if (!filter) return text
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
    .filter((line) => {
      filter.lastIndex = 0
      return filter.test(line.replace(/\n$/, ""))
    })
    .join("")
}

// Cutting bytes mid-character would corrupt the file, so move boundaries off UTF-8 continuation bytes.
function isContinuation(byte: number) {
  return (byte & 0xc0) === 0x80
}

function headEnd(buffer: Buffer, limit: number) {
  let end = Math.min(limit, buffer.length)
  while (end > 0 && end < buffer.length && isContinuation(buffer[end])) end--
  return end
}

function tailOf(buffer: Buffer, cap: number) {
  let start = Math.max(0, buffer.length - cap)
  while (start < buffer.length && isContinuation(buffer[start])) start++
  return buffer.subarray(start)
}

function completeEnd(buffer: Buffer) {
  const length = buffer.length
  const lead = Array.from({ length: Math.min(4, length) }, (_, i) => length - 1 - i).find(
    (i) => !isContinuation(buffer[i]),
  )
  if (lead === undefined) return length
  const need = buffer[lead] >= 0xf0 ? 4 : buffer[lead] >= 0xe0 ? 3 : buffer[lead] >= 0xc0 ? 2 : 1
  return length - lead < need ? lead : length
}
