// Drive parallel streaming sessions against the leak-test server.
// Usage: bun .leak-load/load.mjs [numSessions] [rounds]

const BASE = "http://127.0.0.1:4455"
const DIR = "/home/yeager1977/GitHub/flynncode/.leak-load/scr"
const AUTH = "Basic " + Buffer.from("opencode:leakdebug").toString("base64")

const numSessions = Number(process.argv[2] ?? 8)
const rounds = Number(process.argv[3] ?? 4)

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json", "x-opencode-directory": DIR },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`)
  return res.json()
}

const model = { providerID: "ollama-cloud", modelID: "glm-5.3-flash" }

const sessionIDs = []
for (let i = 0; i < numSessions; i++) {
  const session = await post("/session", { title: `leak-load-${i}` })
  sessionIDs.push(typeof session === "object" && session.id ? session.id : session)
}
console.log("sessions:", sessionIDs.join(", "))

const roundDone = []
for (let round = 1; round <= rounds; round++) {
  const t0 = Date.now()
  await Promise.all(
    sessionIDs.map((id, i) =>
      post(`/session/${id}/prompt_async`, {
        parts: [{ type: "text", text: `Load round ${round} for session ${i}: summarize the files in this directory in one short paragraph. Do not run any commands.` }],
        model,
        agent: "build",
      }),
    ),
  )
  // poll status until all idle
  let busy = true
  while (busy) {
    await Bun.sleep(1000)
    const status = await (await fetch(`${BASE}/session/status`, { headers: { authorization: AUTH, "x-opencode-directory": DIR } })).json()
    const ids = JSON.stringify(status)
    busy = false
    for (const id of sessionIDs) {
      if (!ids.includes(id)) continue
      const entry = Array.isArray(status) ? status.find((s) => s.sessionID === id) : status[id]
      const s = entry && (entry.status ? entry.status.type : entry.type)
      if (s && s !== "idle") busy = true
    }
  }
  roundDone.push(((Date.now() - t0) / 1000).toFixed(1))
  console.log(`round ${round} done in ${roundDone.at(-1)}s (rounds so far: ${roundDone.join(", ")})`)
}
console.log("LOAD COMPLETE")