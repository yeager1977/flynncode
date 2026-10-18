// Drive instance dispose/recreate churn through /global/config updates and
// session creation, sampling the live heap between rounds.
// Usage: bun leak-churn.ts [rounds]
import fs from "node:fs"

const BASE = "http://127.0.0.1:4455"
const DIR = "/home/yeager1977/GitHub/flynncode/.leak-load/scr"
const AUTH = "Basic " + Buffer.from("opencode:leakdebug").toString("base64")
const OUT = "/home/yeager1977/GitHub/flynncode/.leak-load/churn-sample.csv"
const rounds = Number(process.argv[2] ?? 30)
const model = { providerID: "ollama-cloud", modelID: "glm-5.3-flash" }

const headers = { authorization: AUTH, "content-type": "application/json", "x-opencode-directory": DIR }

const sample = async () => {
  try {
    const targets = await (await fetch("http://127.0.0.1:9231/json/list")).json()
    const target = targets.find((t) => t.webSocketDebuggerUrl)
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    let out = ""
    let id = 0
    ws.onmessage = (e) => {
      const d = JSON.parse(String(e.data))
      if (d.id === 2) out = d.result?.result?.value ? d.result.result.value : String(d.result?.result?.description ?? "")
    }
    await new Promise((r, j) => { (ws as any).onopen = r; (ws as any).onerror = j })
    ws.send(JSON.stringify({ id: 1, method: "Runtime.enable", params: {} }))
    await Bun.sleep(150)
    ws.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: "JSON.stringify(process.memoryUsage().heapUsed)", returnByValue: true } }))
    await Bun.sleep(1500)
    ws.close()
    return out
  } catch { return "err" }
}

const sampleAll = async () => {
  const heapUsed = await sample()
  const rss = Number(Bun.spawnSync(["sh", "-c", "pgrep -f sidecar-run.mjs | while read p; do rss=$(ps -p $p -o rss= | tr -d ' '); [ \"${rss:-0}\" -gt 400000 ] && echo $rss && break; done"]).stdout.toString().trim() || 0)
  const line = `${new Date().toISOString()},${rss},${heapUsed}`
  fs.appendFileSync(OUT, line + "\n")
  console.log(`rss=${(rss / 1024).toFixed(0)}MB heapUsed=${typeof heapUsed === "string" ? ((Number(heapUsed.replace(/[",]/g, "")) || 0) / 1048576).toFixed(0) + "MB" : String(heapUsed)}`)
  return line
}

for (let round = 1; round <= rounds; round++) {
  // Flip a real config key so the update reports changed=true, which disposes
  // every instance and emits global disposed (the exact prod settings path).
  const on = round % 2 === 1
  try {
    const res = await fetch(`${BASE}/global/config`, { method: "PATCH", headers, body: JSON.stringify({ experimental: { filewatcher: on } }) })
    if (!res.ok) console.log(`config update ${res.status} ${await res.text().then((t) => t.slice(0, 120))}`)
  } catch (e) {
    console.log("config update error", String(e).slice(0, 120))
  }
  await Bun.sleep(300)
  // Force instances to exist again right after disposal.
  const post = await fetch(`${BASE}/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: `churn-${round}` }),
  })
  await post.json().catch(() => undefined)
  // One tiny prompt every 3rd round so instance state does real work again.
  let created: { id?: string } | undefined
  try {
    created = await post.json()
  } catch {}
  if (round % 3 === 0 && created?.id) {
    const id = created.id
    if (id) {
      await fetch(`${BASE}/session/${id}/prompt_async`, {
        method: "POST", headers,
        body: JSON.stringify({ parts: [{ type: "text", text: `Round ${round}: read /home/yeager1977/GitHub/flynncode/.leak-load/scr/a.txt and reply "ok".` }], model, agent: "build" }),
      }).catch(() => undefined)
    }
  }
  if (round % 5 === 0 || round === 1) await sampleAll()
}
await Bun.sleep(4000)
await sampleAll()
console.log("CHURN DONE")