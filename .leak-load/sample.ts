// Sample the leak-test server's live heap + RSS every N seconds to a CSV.
// Usage: bun sample.mjs [interval_s] [count]
const interval = Number(process.argv[2] ?? 30)
const count = Number(process.argv[3] ?? 240)
const OUT = "/home/yeager1977/GitHub/flynncode/.leak-load/heap-sample.csv"

const pid = (await Bun.file("/proc/net/tcp").text(), null) // placeholder
function serverPid() {
  const out = Bun.spawnSync(["/bin/sh", "-c", "pgrep -f sidecar-run.mjs | while read p; do rss=$(ps -p $p -o rss= | tr -d ' '); [ \"${rss:-0}\" -gt 400000 ] && echo $p && break; done"])
  return out.stdout.toString().trim()
}

console.log("ts,rss_kb,heapUsed,heapTotal,external", ">", OUT)
for (let i = 0; i < count; i++) {
  const p = serverPid()
  if (!p) {
    console.log(`${new Date().toISOString()},none,,,,`, ">>", OUT)
  } else {
    const rss = Number(Bun.spawnSync(["ps", "-p", p, "-o", "rss="]).stdout.toString().trim())
    const mem = await evalCdp("JSON.stringify(process.memoryUsage())")
    console.log(`${new Date().toISOString()},${rss},${mem}`, ">>", OUT)
  }
  await Bun.sleep(interval * 1000)
}

async function evalCdp(expr: string): Promise<string> {
  try {
    const targets = await (await fetch("http://127.0.0.1:9231/json/list")).json()
    const target = targets.find((t) => t.webSocketDebuggerUrl)
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    let result = "no-response"
    let id = 0
    ws.onmessage = (event) => {
      const data = JSON.parse(String(event.data))
      if (data.id === 2) {
        if (data.error) result = "error"
        else result = data.result?.result?.description ?? data.result?.result?.value ?? "undefined"
      }
    }
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    ws.send(JSON.stringify({ id: 1, method: "Runtime.enable", params: {} }))
    await Bun.sleep(200)
    ws.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: `(${expr})`, returnByValue: true } }))
    await Bun.sleep(2500)
    ws.close()
    return String(result).replace(/,/g, " ")
  } catch (e) {
    return "cdp-error"
  }
}
process.exit(0)