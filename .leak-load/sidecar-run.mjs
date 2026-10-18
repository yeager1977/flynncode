import { EventEmitter } from "node:events"
import { appendFileSync } from "node:fs"

const EVENTS_PATH = "/home/yeager1977/GitHub/flynncode/.leak-load/sidecar-events.logl"
// The upstream plugin gates on process.argv containing "serve" (as `opencode
// serve` does). Provide it for tests when asked.
if (process.env.SIDECAR_ARGV_EXTRA) process.argv.push(...process.env.SIDECAR_ARGV_EXTRA.split(","))

const port = new EventEmitter()
port.postMessage = (message) => {
  try {
    appendFileSync(EVENTS_PATH, `${new Date().toISOString()} ${JSON.stringify(message).slice(0, 400)}\n`)
  } catch {}
  console.log("[sidecar-out]", JSON.stringify(message).slice(0, 300))
}
process.parentPort = port

await import("/home/yeager1977/GitHub/flynncode/.debdebug/extract/out/main/sidecar.js")

port.emit("message", {
  data: {
    type: "start",
    hostname: "127.0.0.1",
    port: Number(process.env.SIDECAR_PORT ?? 4455),
    password: "leakdebug",
    userDataPath: "/home/yeager1977/GitHub/flynncode/.leak-load/appdata",
    mobile: { password: "loadtest", port: 0 },
    relay: { token: "t", remoteToken: "r", url: "https://127.0.0.1:1" },
    sync: { machineName: "leaktest", phoneAccess: false, paused: true, peer: null, prefs: null },
  },
})