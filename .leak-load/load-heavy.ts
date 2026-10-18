// Prod-scale leak load: tool-churning agent turns + growing session histories
// + synthetic UI SSE clients. Usage: bun load-heavy.mjs [sessions] [rounds]
const BASE = "http://127.0.0.1:4455"
const DIR = "/home/yeager1977/GitHub/flynncode/.leak-load/scr"
const AUTH = "Basic " + Buffer.from("opencode:leakdebug").toString("base64")

const numSessions = Number(process.argv[2] ?? 6)
const rounds = Number(process.argv[3] ?? 30)
const model = { providerID: "ollama-cloud", modelID: "glm-5.3-flash" }

const post = async (path: string, body?: unknown) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json", "x-opencode-directory": DIR },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

// Synthetic UI clients: hold the global event bus open exactly like desktop windows do.
const sseClients = Array.from({ length: 3 }, async (_, i) => {
  const res = await fetch(`${BASE}/global/event`, { headers: { authorization: AUTH, accept: "text/event-stream" } })
  // consume lazily; keep the socket warm
  const reader = res.body?.getReader()
  if (!reader) return
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      void value
    }
  } catch {}
})
void sseClients

const sessionIDs: string[] = []
for (let i = 0; i < numSessions; i++) {
  const session = await post("/session", { title: `leak-heavy-${i}` })
  sessionIDs.push(session.id)
}
console.log("sessions ready:", sessionIDs.length)

// Churn file so read/edit tools and the snapshot tracker have real work.
const churn = pathWrite("churn.txt")
function pathWrite(name: string) {
  const file = `${DIR}/${name}`
  return async (round: number) => {
    await Bun.write(file, `round ${round} content line for the tool churn load test: ${"x".repeat(Math.min(2000, round * 50))}`)
  }
}

for (let round = 1; round <= rounds; round++) {
  const t0 = Date.now()
  await churn(round)
  await Promise.all(
    sessionIDs.map((id, i) =>
      post(`/session/${id}/prompt_async`, {
        parts: [{ type: "text", text: `Round ${round}: Read ${DIR}/churn.txt, then read ${DIR}/a.txt, then reply with one sentence about both files. Do not modify anything.` }],
        model,
        agent: "build",
      }),
    ),
  )
  let settled = false
  for (let wait = 0; wait < 240 && !settled; wait++) {
    await Bun.sleep(2000)
    const res = await fetch(`${BASE}/session/status`, { headers: { authorization: AUTH, "x-opencode-directory": DIR } })
    const status = await res.json()
    const blob = JSON.stringify(status)
    settled = !sessionIDs.some((id) => {
      const hit = blob.includes(id)
      return hit && (blob.split(id).length > 2)
    })
    // fallthrough: rely on prompt responses appearing; simpler robust check below
    if (wait % 30 === 29) console.log(`round ${round} still busy after ${(wait + 1) * 2}s`)
  }
  console.log(`round ${round} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}
console.log("HEAVY LOAD COMPLETE")