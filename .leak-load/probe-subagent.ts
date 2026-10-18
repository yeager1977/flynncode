// Record every session.status/status event on the wire while driving one
// parent session through a subagent task; afterwards dump the server's
// session_status truth for all sessions involved.
// Usage: bun probe-subagent.mjs
import fs from "node:fs"

const BASE = "http://127.0.0.1:4455"
const DIR = "/home/yeager1977/GitHub/flynncode/.leak-load/scr"
const AUTH = "Basic " + Buffer.from("opencode:leakdebug").toString("base64")
const OUT = "/home/yeager1977/GitHub/flynncode/.leak-load/subagent-events.log"

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

const log = (line: string) => {
  fs.appendFileSync(OUT, `${new Date().toISOString()} ${line}\n`)
  console.log(line)
}

// 1. capture every status-ish event
const events: string[] = []
const cap = fetch(`${BASE}/global/event`, { headers: { authorization: AUTH, accept: "text/event-stream" } }).then(
  async (res) => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let end
      while ((end = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, end)
        buf = buf.slice(end + 2)
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))
        if (!dataLine) continue
        try {
          const parsed = JSON.parse(dataLine.slice(6))
          const type = parsed?.payload?.type ?? parsed?.type ?? ""
          if (String(type).includes("status") || String(type).includes("idle")) {
            const t = new Date().toISOString().slice(11, 19)
            const line = `${t} ${JSON.stringify(parsed).slice(0, 220)}`
            events.push(line)
            fs.appendFileSync(OUT, line + "\n")
          }
        } catch {}
      }
    }
  },
)
void cap

// 2. parent session + subagent task
const parent = await post("/session", { title: "subagent-probe-parent" })
log(`parent=${parent.id}`)
await post(`/session/${parent.id}/prompt_async`, {
  parts: [{ type: "text", text: "Use the task tool to spawn a general subagent that reads /home/yeager1977/GitHub/flynncode/.leak-load/scr/a.txt and reports a two-line summary. Wait for the subagent to finish, then in ONE short sentence tell me what it said." }],
  model: { providerID: "ollama-cloud", modelID: "glm-5.3-flash" },
  agent: "build",
})

// 3. poll active() for 3 minutes, log the busy set over time
const start = Date.now()
let quietSince: number | undefined
let prevActive = ""
while (Date.now() - start < 180000) {
  await Bun.sleep(3000)
  const active = await fetch(`${BASE}/session/active`, { headers: { authorization: AUTH, "x-opencode-directory": DIR } })
    .then((r) => r.json())
    .catch(() => ({}))
  const blob = JSON.stringify(active)
  const key = blob
  if (key !== prevActive) {
    log(`active ${JSON.stringify(active).slice(0, 300)}`)
    prevActive = key
  }
  const isQuiet = blob === "{}" || blob === '{"sessions":{}}'
  if (isQuiet && quietSince === undefined) quietSince = Date.now()
  if (!isQuiet) quietSince = undefined
  if (quietSince !== undefined && Date.now() - quietSince > 30000) {
    log("QUIET for 30s — stopping early")
    break
  }
}

const parentStatus = await fetch(`${BASE}/session/${parent.id}/status`, { headers: { authorization: AUTH, "x-opencode-directory": DIR } }).then((r) => r.json()).catch((e) => String(e))
log(`parent status: ${JSON.stringify(parentStatus)}`)

// list all child sessions of the parent and their statuses
const sessions = await fetch(`${BASE}/session`, { headers: { authorization: AUTH, "x-opencode-directory": DIR } }).then((r) => r.json())
const children = (Array.isArray(sessions) ? sessions : sessions.sessions ?? [])
  .filter((s: any) => s.parentID === parent.id)
for (const child of children) {
  const status = await fetch(`${BASE}/session/${child.id}/status`, { headers: { authorization: AUTH, "x-opencode-directory": DIR } }).then((r) => r.json()).catch(() => "?")
  log(`child ${child.id} "${child.title}" status=${JSON.stringify(status)}`)
}
log(`captured ${events.length} status events`)
console.log("PROBE DONE")