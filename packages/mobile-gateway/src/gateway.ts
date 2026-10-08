import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { SESSION_COOKIE, readCookie, sessionCookie } from "./cookies.ts"
import { envAuthHeader, type GatewayOptions } from "./config.ts"
import { streamThrough } from "./proxy.ts"
import { createSessionStore } from "./session.ts"
import { Upstream, upstreamHeaders, upstreamUrl } from "./upstream.ts"
import { buildStatusPayload, listLanIPv4 } from "./lan-ips.ts"
import { loadLauncher } from "./launcher.ts"
import { listNeedsInput } from "./inbox.ts"
import { createRelayStore, isRelayAuthorized, type RelayDigest } from "./relay.ts"
import { renderLauncher, renderUnauthorized, renderUnreachable } from "./launcher-html.ts"

const UNAUTHORIZED = 'Basic realm="opencode-mobile"'

// Hardening caps for the relay publish endpoint: digests are small metadata
// payloads, so anything larger is rejected before parsing.
const RELAY_MAX_BODY_BYTES = 64 * 1024
const RELAY_MAX_ORIGIN_CHARS = 64
const RELAY_MAX_ITEMS = 50

export type Gateway = {
  port: number
  stop(): void
}

type RunningState = { server: Server; port: number; refs: number; stop: () => void }

let running: RunningState | undefined

// Relay digests live in the gateway process (in-memory, 24h TTL). On the
// deepthought host this store is what the phone reads while away; on a laptop
// it stays empty unless something publishes to it.
const relayStore = createRelayStore()

function unauthorized() {
  return new Response("Authentication required", { status: 401, headers: { "www-authenticate": UNAUTHORIZED } })
}

function decodeBasic(header: string | null) {
  if (!header) return
  const match = /^Basic\s+(.+)$/i.exec(header)
  if (!match) return
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8")
    const separator = decoded.indexOf(":")
    if (separator === -1) return
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
  } catch {
    return
  }
}

function isLauncherPath(url: string) {
  const pathname = new URL(url, "http://localhost").pathname
  return pathname === "/m" || pathname === "/m/"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRelayDigest(body: unknown): RelayDigest | undefined {
  if (!isRecord(body)) return
  if (typeof body.originID !== "string" || !body.originID || body.originID.length > RELAY_MAX_ORIGIN_CHARS) return
  if (typeof body.updatedAt !== "number" || !Number.isFinite(body.updatedAt)) return
  if (!Array.isArray(body.items)) return
  const items: RelayDigest["items"] = []
  for (const entry of body.items) {
    if (!isRecord(entry)) return
    if (typeof entry.sessionID !== "string" || !entry.sessionID) return
    if (typeof entry.title !== "string") return
    if (typeof entry.updated !== "number" || !Number.isFinite(entry.updated)) return
    if (entry.kind !== "permission" && entry.kind !== "question") return
    // Digest fields are metadata only: sessionID, title, directory, kind,
    // updated. Anything else in the body is dropped before storing.
    items.push({
      sessionID: entry.sessionID,
      directory: typeof entry.directory === "string" ? entry.directory : undefined,
      title: entry.title,
      kind: entry.kind,
      updated: entry.updated,
    })
  }
  // Keep the newest digests when a publisher sends more than the cap.
  items.sort((a, b) => b.updated - a.updated)
  return { originID: body.originID, items: items.slice(0, RELAY_MAX_ITEMS), updatedAt: body.updatedAt }
}

export function createGateway(input: { options: GatewayOptions }) {
  const options = input.options
  const authorization = envAuthHeader(options)
  const sessions = createSessionStore()

  function matchesEnv(credentials: { username: string; password: string }) {
    return credentials.username === options.username && credentials.password === options.password
  }

  return async function handle(request: Request): Promise<Response> {
    const parsed = new URL(request.url, "http://localhost")
    if (parsed.pathname === "/flynncode-mobile-status") {
      // WHATWG URL keeps IPv6 brackets in hostname ("[::1]"), so strip them.
      // The payload carries only the port and LAN URLs (no secrets); localhost
      // gating keeps it off the LAN rather than protecting sensitive data.
      const host = parsed.hostname.replace(/^\[|\]$/g, "")
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
        return new Response("Not found", { status: 404 })
      }
      const payload = buildStatusPayload({ port: options.port, ips: listLanIPv4() })
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    if (parsed.pathname === "/flynncode-mobile-relay/publish") {
      // The laptop publisher authenticates with the relay bearer token, not
      // the phone credential, so this route sits before the phone gate and is
      // reachable over the LAN/Tailscale.
      if (!options.relayToken) return new Response("Relay disabled", { status: 503 })
      if (!isRelayAuthorized(request.headers.get("authorization"), options.relayToken)) {
        return new Response("Forbidden", { status: 403 })
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
      const contentType = request.headers.get("content-type") ?? ""
      if (!contentType.includes("application/json")) return new Response("Bad request", { status: 400 })
      const declaredLength = Number(request.headers.get("content-length") ?? 0)
      if (Number.isFinite(declaredLength) && declaredLength > RELAY_MAX_BODY_BYTES) {
        return new Response("Payload too large", { status: 413 })
      }
      const body = await request.json().catch(() => undefined)
      // The header pre-check above is only a fast path: chunked bodies carry
      // no content-length, so enforce the cap on the serialized post-parse
      // length as well. Parsed JSON always re-serializes to a string.
      if ((JSON.stringify(body) ?? "").length > RELAY_MAX_BODY_BYTES) {
        return new Response("Payload too large", { status: 413 })
      }
      const digest = parseRelayDigest(body)
      if (!digest) return new Response("Bad request", { status: 400 })
      relayStore.publish(digest)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE)
    const cookieValid = token !== undefined && sessions.verify(token)

    let issued: string | undefined
    if (!cookieValid) {
      const credentials = decodeBasic(request.headers.get("authorization"))
      if (!credentials) return unauthorized()
      if (!matchesEnv(credentials)) return unauthorized()
      const probe = await Upstream.probe({ base: options.upstream, authorization })
      if (!probe.ok && probe.reason === "unreachable") {
        return new Response("Upstream server unreachable", { status: 503 })
      }
      if (!probe.ok) return unauthorized()
      issued = sessions.issue()
    }

    const inboxPath = new URL(request.url, "http://localhost").pathname
    if (inboxPath === "/flynncode-mobile-relay/inbox") {
      if (!options.relayToken) return new Response("Relay disabled", { status: 503 })
      const response = new Response(JSON.stringify({ digests: relayStore.list() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
      if (issued !== undefined) response.headers.set("set-cookie", sessionCookie(issued))
      return response
    }

    if (inboxPath === "/flynncode-mobile-inbox") {
      const loaded = await listNeedsInput({ upstream: options.upstream, authorization })
      if (loaded.kind === "unauthorized") return unauthorized()
      if (loaded.kind === "unreachable") return new Response("Upstream server unreachable", { status: 503 })
      const response = new Response(JSON.stringify({ items: loaded.items }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
      if (issued !== undefined) response.headers.set("set-cookie", sessionCookie(issued))
      return response
    }

    if (isLauncherPath(request.url)) {
      const [loaded, inbox] = await Promise.all([
        loadLauncher({ upstream: options.upstream, authorization }),
        listNeedsInput({ upstream: options.upstream, authorization }),
      ])
      const page =
        loaded.kind === "unreachable"
          ? renderUnreachable()
          : loaded.kind === "unauthorized"
            ? renderUnauthorized()
            : renderLauncher({ data: loaded.data, now: Date.now(), partial: loaded.partial, inbox: inbox.kind === "loaded" ? inbox.items : [], relay: relayStore.list() })
      const response = new Response(page, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
      if (issued !== undefined) response.headers.set("set-cookie", sessionCookie(issued))
      return response
    }

    const target = upstreamUrl(options.upstream, request.url)
    const headers = upstreamHeaders({
      base: options.upstream,
      authorization,
      incoming: Object.fromEntries(request.headers.entries()),
    })
    const method = request.method
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer()

    let upstream: Response
    try {
      upstream = await fetch(target, { method, headers, body })
    } catch {
      return new Response("Upstream unavailable", { status: 502 })
    }

    const response = streamThrough(upstream)
    if (issued !== undefined) response.headers.set("set-cookie", sessionCookie(issued))
    return response
  }
}

export async function startGateway(input: { options: GatewayOptions; port?: number }): Promise<Gateway> {
  if (running) {
    running.refs += 1
    const state = running
    const released = { value: false }
    return { port: state.port, stop: () => release(state, released) }
  }
  const handle = createGateway({ options: input.options })
  const server = createServer((request, response) => {
    Promise.resolve()
      .then(() => requestFromNode(request))
      .then(handle)
      .then((result) => writeToNode(response, result))
      .catch(() => {
        response.writeHead(500)
        response.end("Internal error")
      })
  })
  const port = await listen(server, input.options.host, input.port ?? input.options.port)
  running = {
    server,
    port,
    refs: 1,
    stop: () => {
      server.closeAllConnections()
      server.close()
      if (running?.server === server) running = undefined
    },
  }
  const state = running
  const released = { value: false }
  return { port, stop: () => release(state, released) }
}

function listen(server: Server, host: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.removeListener("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve gateway port"))
        return
      }
      resolve(address.port)
    })
  })
}

function requestFromNode(request: IncomingMessage) {
  const method = request.method ?? "GET"
  const url = `http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`
  const body = method === "GET" || method === "HEAD" ? undefined : (Readable.toWeb(request) as unknown as BodyInit)
  // RequestInit in the DOM lib lacks `duplex`, but Node's fetch requires it for streaming bodies.
  return new Request(url, {
    method,
    headers: request.headers as Record<string, string>,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" }) as Request
}

async function writeToNode(response: ServerResponse, result: Response) {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of result.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue
    headers[key] = value
  }
  const cookies = result.headers.getSetCookie()
  if (cookies.length) headers["set-cookie"] = cookies
  response.writeHead(result.status, headers)
  if (!result.body) {
    response.end()
    return
  }
  await pipeline(Readable.fromWeb(result.body as never), response).catch(() => response.end())
}

// The plugin hook is created once per opened directory, so the gateway is
// reference-counted. The last disposer closes the listener. Each handle
// releases at most once and is bound to the server instance it was created
// for, so a stale handle after a restart cannot decrement the new server.
function release(state: RunningState, released: { value: boolean }) {
  if (released.value) return
  released.value = true
  if (state.refs <= 0) return
  state.refs -= 1
  if (state.refs > 0) return
  state.stop()
}

export function stopGateway() {
  running?.stop()
}