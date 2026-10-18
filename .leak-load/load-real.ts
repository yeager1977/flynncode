// Mimic prod peer sessions: 4 long-lived sessions doing real file work with
// growing context + occasional subagent fanout. Usage: bun load-real.ts [rounds]
const BASE = "http://127.0.0.1:4455"
const DIR = "/home/yeager1977/GitHub/flynncode/.leak-load/scr"
const AUTH = "Basic " + Buffer.from("opencode:leakdebug").toString("base64")
const REPO = "/home/yeager1977/GitHub/flynncode/packages/flynncode/src"

const rounds = Number(process.argv[2] ?? 15)
const model = { providerID: "ollama-cloud", modelID: "glm-5.3-flash" }

const post = async (path: string, body?: unknown, timeoutMs = 600000) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json", "x-opencode-directory": DIR },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

// Keep the server hot like a UI would: one SSE listener.
const sse = fetch(`${BASE}/global/event`, { headers: { authorization: AUTH, accept: "text/event-stream" } })
  .then((res) => {
    const reader = res.body?.getReader()
    if (!reader) return
    const loop = async () => {
      try {
        while (true) { const { done } = await reader.read(); if (done) return }
      } catch {}
    }
    return loop()
  })
void sse

const workers = [
  { id: "", name: "explorer" },
  { id: "", name: "reader" },
  { id: "", name: "mapper" },
  { id: "", name: "summarizer" },
]

for (const worker of workers) {
  const session = await post("/session", { title: `leak-real-${worker.name}` })
  worker.id = session.id
}
console.log("workers:", workers.map((worker) => worker.id).join(","))

const prompts = [
  (round: number, name: string) => `Work round ${round} (${name}): list the files under ${DIR}, read ${REPO}/index.ts, and summarize what this package's entrypoint does in 2 sentences. No modifications.`,
  (round: number, name: string) => `Work round ${round} (${name}): read ${REPO}/server/server.ts and ${REPO}/session/prompt.ts (first 400 lines each). Describe their responsibilities briefly. No modifications.`,
  (round: number, name: string) => `Work round ${round} (${name}): use the task tool to spawn a general subagent that reads ${REPO}/plugin/loader.ts and reports its 3 most important functions. Then tell me the summary. No modifications.`,
  (round: number, name: string) => `Work round ${round} (${name}): grep the repo at ${REPO} for "Layer.effect" and count matches. Then write a one-line note to ${DIR}/notes-${round}.md. Then read that note back.`,
]

let failedTurns = 0
for (let round = 0; round < rounds; round++) {
  const t0 = Date.now()
  const variant = round % prompts.length
  const results = await Promise.all(
    workers.map((worker) =>
      post(`/session/${worker.id}/prompt_async`, { parts: [{ type: "text", text: prompts[variant](round, worker.name) }], model, agent: "build" })
        .then(() => "ok")
        .catch(() => "fail"),
    ),
  )
  failedTurns += results.filter((r) => r === "fail").length
  // Poll every turn's session until idle before next round (real sequential usage)
  let busy = true
  let waited = 0
  while (busy && waited < 420) {
    await Bun.sleep(5000)
    waited += 5
    try {
      const status = await (await fetch(`${BASE}/session/status`, { headers: { authorization: AUTH, "x-opencode-directory": DIR } })).json()
      const blob = JSON.stringify(status)
      busy = workers.some((worker) => blob.includes(worker.id))
    } catch { busy = false }
  }
  console.log(`round ${round} (${variant}) waited ${waited}s; post-fails so far: ${failedTurns}`)
}
console.log("REAL LOAD COMPLETE")