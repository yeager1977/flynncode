import { createServer } from "node:http"
import { startGateway } from "../../src/gateway.ts"

const upstream = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" })
  response.end("upstream-ok")
})
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
const upstreamPort = upstream.address().port

const gateway = await startGateway({
  options: {
    host: "127.0.0.1",
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    username: "opencode",
    password: "secret",
  },
})

const unauthorized = await fetch(`http://127.0.0.1:${gateway.port}/api/health`)
const authorized = await fetch(`http://127.0.0.1:${gateway.port}/api/health`, {
  headers: { authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}` },
})
const body = await authorized.text()
const cookie = authorized.headers.getSetCookie()[0] ?? ""

gateway.stop()
upstream.close()

if (unauthorized.status !== 401) throw new Error(`expected 401, got ${unauthorized.status}`)
if (authorized.status !== 200) throw new Error(`expected 200, got ${authorized.status}`)
if (body !== "upstream-ok") throw new Error(`unexpected body: ${body}`)
if (!cookie.includes("oc_mobile_session=")) throw new Error("missing session cookie")

const plugin = await import("../../src/index.ts")
const entry = plugin.default
if (!entry || entry.id !== "@flynncode/mobile-gateway" || typeof entry.server !== "function") {
  throw new Error("plugin entry did not load under node")
}

console.log("NODE_RUNTIME_OK")