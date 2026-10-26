export * as BackgroundOutput from "./output"

import fs from "fs/promises"

const DEFAULT_CAP_BYTES = 50 * 1024 * 1024
const DEFAULT_HEAD_BYTES = 1024 * 1024
const DEFAULT_WINDOW_BYTES = 1024 * 1024
const DEFAULT_READ_BYTES = 50 * 1024
const DEFAULT_FLUSH_MS = 5_000

export type Writer = {
  write(chunk: string): void
  readSince(offset: number, input?: { filter?: RegExp; maxBytes?: number }): { text: string; offset: number; skipped: number }
  lastLines(count: number): string
  total(): number
  truncated(): boolean
  pendingBytes(): number
  close(): Promise<void>
}

// Readers use logical stream positions (bytes ever written) against an in-memory window of the newest
// output; the file is only persistence, so rewriting it after the cap never invalidates a reader's offset.
export function open(
  file: string,
  input?: { capBytes?: number; headBytes?: number; windowBytes?: number; flushMs?: number },
): Writer {
  const capBytes = input?.capBytes ?? DEFAULT_CAP_BYTES
  const headBytes = Math.min(input?.headBytes ?? DEFAULT_HEAD_BYTES, capBytes)
  const windowBytes = input?.windowBytes ?? DEFAULT_WINDOW_BYTES
  const flushMs = input?.flushMs ?? DEFAULT_FLUSH_MS
  const tailCap = capBytes - headBytes
  const temp = `${file}.tmp`

  let total = 0
  let closed = false
  let recent: Buffer[] = []
  let recentLength = 0
  let head: Buffer[] = []
  let headLength = 0
  let headFull = false

  // Bytes accepted but not yet handed to the disk: the contiguous range [pendingStart, total).
  let pending: Buffer[] = []
  let pendingLength = 0
  let pendingStart = 0
  let scheduled = false

  // File state, touched only inside the serialized chain.
  let onDisk = 0
  let rolling = false
  let tail: Buffer[] = []
  let tailLength = 0
  let tailEnd = 0
  let dirty = false
  let lastRewrite = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  // open() starts a fresh file; every later disk operation queues behind this one.
  let chain = fs.writeFile(file, "").catch(() => undefined)

  function schedule() {
    if (scheduled) return
    scheduled = true
    // A failed disk operation must never break the shell producing the output.
    chain = chain.then(flush).catch(() => undefined)
  }

  async function flush() {
    scheduled = false
    if (pendingLength === 0) return
    const batch = Buffer.concat(pending)
    const start = pendingStart
    pending = []
    pendingLength = 0
    pendingStart = start + batch.length
    if (!rolling && start === onDisk && start + batch.length <= capBytes) {
      const appended = await fs.appendFile(file, batch).then(
        () => true,
        () => false,
      )
      if (appended) {
        onDisk += batch.length
        return
      }
      // Retry with the next flush unless newer bytes were dropped meanwhile (the batch would no longer be contiguous).
      if (pendingStart !== start + batch.length) return
      pending.unshift(batch)
      pendingLength += batch.length
      pendingStart = start
      boundPending()
      return
    }
    if (!rolling) {
      rolling = true
      tailEnd = headLength
      const disk = onDisk > 0 ? await fs.readFile(file).catch(() => Buffer.alloc(0)) : Buffer.alloc(0)
      appendTail(disk.subarray(0, Math.min(onDisk, disk.length)), 0)
    }
    appendTail(batch, start)
    dirty = true
    if (Date.now() - lastRewrite >= flushMs) return rewrite()
    arm()
  }

  // Keeps the newest contiguous run of bytes after the head; a gap (dropped pending bytes) restarts it.
  function appendTail(data: Buffer, start: number) {
    const end = start + data.length
    if (end <= tailEnd) return
    if (start > tailEnd) {
      tail = []
      tailLength = 0
    }
    const piece = data.subarray(Math.max(0, tailEnd - start))
    tail.push(piece)
    tailLength = keepNewest(tail, tailLength + piece.length, tailCap)
    tailEnd = end
  }

  async function rewrite() {
    if (!dirty) return
    dirty = false
    lastRewrite = Date.now()
    const headKept = Buffer.concat(head)
    const kept = Buffer.concat(tail)
    const tailKept = kept.subarray(charStart(kept, 0))
    const marker = Buffer.from(`\n...[output truncated: ${tailEnd - headKept.length - tailKept.length} bytes dropped]...\n`)
    // Write a sibling file and rename it over the original so readers never see a partial file.
    await fs
      .writeFile(temp, Buffer.concat([headKept, marker, tailKept]))
      .then(() => fs.rename(temp, file))
      .catch(async () => {
        dirty = true
        await fs.rm(temp, { force: true }).catch(() => undefined)
        arm()
      })
  }

  function arm() {
    if (timer || closed) return
    timer = setTimeout(
      () => {
        timer = undefined
        chain = chain.then(rewrite).catch(() => undefined)
      },
      Math.max(0, lastRewrite + flushMs - Date.now()),
    )
    timer.unref()
  }

  // A stalled disk must not grow memory without bound: drop the oldest queued bytes beyond the cap.
  function boundPending() {
    const before = pendingLength
    pendingLength = keepNewest(pending, pendingLength, capBytes)
    pendingStart += before - pendingLength
  }

  return {
    write(chunk) {
      const data = Buffer.from(chunk)
      if (closed || data.length === 0) return
      total += data.length
      if (!headFull) {
        const room = headBytes - headLength
        // Cut on a character boundary so the file head never ends mid-character; the tail starts at headLength.
        const take = data.length <= room ? data.length : characterEnd(data, room)
        head.push(take === data.length ? data : Buffer.from(data.subarray(0, take)))
        headLength += take
        headFull = take < data.length || headLength >= headBytes
      }
      recent.push(data)
      recentLength = keepNewest(recent, recentLength + data.length, windowBytes)
      pending.push(data)
      pendingLength += data.length
      boundPending()
      schedule()
    },
    readSince(offset, options) {
      const maxBytes = options?.maxBytes !== undefined && options.maxBytes > 0 ? Math.floor(options.maxBytes) : DEFAULT_READ_BYTES
      const recentStart = total - recentLength
      const requested = offset > 0 ? Math.min(Math.floor(offset), total) : 0
      const from = Math.max(requested, recentStart)
      const window = Buffer.concat(recent).subarray(from - recentStart)
      // A filtered read stops after the last complete line so a match split across reads is found next time;
      // once the writer is closed nothing more will arrive, so the partial last line is included.
      const end = options?.filter && !closed ? window.lastIndexOf(10) + 1 : window.length
      const range = window.subarray(0, end)
      const first = charStart(range, 0)
      const filtered = Buffer.from(filterLines(range.subarray(first).toString("utf8"), options?.filter))
      const start = charStart(filtered, Math.max(0, filtered.length - maxBytes))
      // `skipped` counts bytes of [requested, offset) that were dropped without being returned: bytes that fell out
      // of the window, a partial leading character, and bytes clipped by maxBytes. Lines removed by the filter are not counted.
      const skipped = from - requested + first + start
      const text = filtered.subarray(start).toString("utf8")
      const prefix = skipped > 0 && (!options?.filter || text) ? `...[${skipped} bytes skipped]...\n` : ""
      return { text: prefix + text, offset: from + end, skipped }
    },
    lastLines(count) {
      if (count <= 0) return ""
      const data = Buffer.concat(recent)
      return data
        .subarray(charStart(data, 0))
        .toString("utf8")
        .replace(/\n$/, "")
        .split("\n")
        .slice(-count)
        .join("\n")
    },
    total: () => total,
    truncated: () => total > capBytes,
    pendingBytes: () => pendingLength,
    async close() {
      closed = true
      clearTimeout(timer)
      timer = undefined
      chain = chain
        .then(flush)
        .then(() => (rolling ? rewrite() : undefined))
        .catch(() => undefined)
      await chain
      // Only the read window outlives close().
      pending = []
      pendingLength = 0
      head = []
      tail = []
      tailLength = 0
    },
  }
}

// Mutates `chunks` to hold only the newest `limit` bytes and returns the new length.
function keepNewest(chunks: Buffer[], length: number, limit: number) {
  if (length <= limit) return length
  let size = length
  let count = 0
  while (count < chunks.length && size - chunks[count].length >= limit) size -= chunks[count++].length
  chunks.splice(0, count)
  if (size <= limit) return size
  // Copy the kept part so a huge chunk is not retained through a view.
  chunks[0] = Buffer.from(chunks[0].subarray(size - limit))
  return limit
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

// Cutting bytes mid-character would corrupt text, so move boundaries off UTF-8 continuation bytes.
function isContinuation(byte: number) {
  return (byte & 0xc0) === 0x80
}

// The largest end <= limit that does not split a character of `buffer`.
function characterEnd(buffer: Buffer, limit: number) {
  let end = limit
  while (end > 0 && isContinuation(buffer[end])) end--
  return end
}

function charStart(buffer: Buffer, from: number) {
  let start = from
  while (start < buffer.length && isContinuation(buffer[start])) start++
  return start
}
