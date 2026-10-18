// Take a V8 heap snapshot from the leak-test server via CDP and save it to disk.
// Usage: bun .leak-load/snap.mjs <output-file.heapsnapshot>
const out = process.argv[2]
if (!out) { console.error("usage: snap.mjs <output.heapsnapshot>"); process.exit(1) }

const targets = await (await fetch("http://127.0.0.1:9231/json/list")).json()
const target = targets.find((t) => t.webSocketDebuggerUrl)
if (!target) { console.error("no debugger target"); process.exit(2) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })

const chunks = []
let bytes = 0
let done = false
ws.onmessage = (event) => {
  const data = JSON.parse(String(event.data))
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id)
    pending.delete(data.id)
    if (data.error) reject(new Error(JSON.stringify(data.error)))
    else resolve(data.result)
    return
  }
  if (data.method === "HeapProfiler.addHeapSnapshotChunk") {
    chunks.push(data.params.chunk)
    bytes += data.params.chunk.length
    if (bytes % 262144 === 0) process.stdout.write(`\r${(bytes / 1048576).toFixed(0)} MB   `)
  }
  if (data.method === "HeapProfiler.reportHeapSnapshotProgress") {
    if (data.params.done === data.params.total) done = true
  }
}

await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
await send("HeapProfiler.enable").catch(() => {})
const t0 = Date.now()
const snapshotPromise = send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: true })
// sendHeapSnapshotTermination isn't needed; wait for chunks then the response
await snapshotPromise
// The snapshot usually finishes chunks before resolving; give chunks a moment to settle
await new Promise((r) => setTimeout(r, 1000))
await import("node:fs").then((fs) => fs.promises.writeFile(out, chunks.join("")))
console.log(`\nsnapshot written: ${out} (${(bytes / 1048576).toFixed(0)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
ws.close()
process.exit(0)