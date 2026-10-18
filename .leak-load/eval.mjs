// Evaluate a JS expression on the leak-test server via the inspector (CDP) and print the result.
// Usage: bun .leak-load/eval.mjs "<expr>"
import fs from "node:fs"

const expr = process.argv[2] ?? "JSON.stringify(process.memoryUsage())"
const targets = await (await fetch("http://127.0.0.1:9231/json/list")).json()
const target = targets.find((t) => t.webSocketDebuggerUrl)
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Set()
ws.onmessage = (event) => {
  const data = JSON.parse(String(event.data))
  if (data.id && pending.has(data.id)) {
    pending.delete(data.id)
    if (data.error) console.log("ERROR", JSON.stringify(data.error))
    else console.log(data.result?.result?.description ?? data.result?.result?.value)
  }
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
const send = ws.send.bind(ws)
const mid = ++id
pending.add(mid)
send(JSON.stringify({ id: mid, method: "Runtime.enable", params: {} }))
await new Promise((r) => setTimeout(r, 300))
const mid2 = ++id
pending.add(mid2)
send(JSON.stringify({ id: mid2, method: "Runtime.evaluate", params: { expression: `(${expr})`, returnByValue: true } }))
await new Promise((r) => setTimeout(r, 3000))
ws.close()
process.exit(0)