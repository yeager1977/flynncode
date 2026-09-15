import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { SESSION_COOKIE, readCookie, sessionCookie } from "./cookies"
import { envAuthHeader, type GatewayOptions } from "./config"
import { streamThrough } from "./proxy"
import { createSessionStore } from "./session"
import { Upstream, upstreamHeaders, upstreamUrl } from "./upstream"

const UNAUTHORIZED = 'Basic realm="opencode-mobile"'

export type Gateway = {
  port: number
  stop(): void
}

type RunningState = { server: Server; port: number; refs: number; stop: () => void }

let running: RunningState | undefined

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

export function createGateway(input: { options: GatewayOptions }) {
  const options = input.options
  const authorization = envAuthHeader(options)
  const sessions = createSessionStore()

  function matchesEnv(credentials: { username: string; password: string }) {
    return credentials.username === options.username && credentials.password === options.password
  }

  return async function handle(request: Request): Promise<Response> {
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
    Promise.resolve(requestFromNode(request))
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