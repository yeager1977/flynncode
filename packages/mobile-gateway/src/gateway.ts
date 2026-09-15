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

let running: { server: ReturnType<typeof Bun.serve>; refs: number; stop: () => void } | undefined

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
      if (probe.ok === false && probe.reason === "unreachable") {
        return new Response("Upstream server unreachable", { status: 503 })
      }
      if (probe.ok === false) return unauthorized()
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
    return { port: state.server.port ?? 0, stop: () => release(state, released) }
  }
  const handle = createGateway({ options: input.options })
  const server = Bun.serve({
    hostname: input.options.host,
    port: input.port ?? input.options.port,
    fetch: handle,
  })
  running = {
    server,
    refs: 1,
    stop: () => {
      server.stop(true)
      if (running?.server === server) running = undefined
    },
  }
  const state = running
  const released = { value: false }
  return { port: server.port ?? 0, stop: () => release(state, released) }
}

// The plugin hook is created once per opened directory, so the gateway is
// reference-counted. The last disposer closes the listener. Each handle
// releases at most once and is bound to the server instance it was created
// for, so a stale handle after a restart cannot decrement the new server.
function release(state: { server: ReturnType<typeof Bun.serve>; refs: number; stop: () => void }, released: { value: boolean }) {
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