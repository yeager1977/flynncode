import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createGateway, startGateway, stopGateway } from "../src/gateway"
import { SESSION_COOKIE } from "../src/cookies"
import type { GatewayOptions } from "../src/config"

const options: GatewayOptions = {
  host: "127.0.0.1",
  port: 0,
  upstream: "",
  username: "opencode",
  password: "secret",
  upstreamPassword: "secret",
}

const basic = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`

let upstream: ReturnType<typeof Bun.serve>
let upstreamRequests: string[] = []

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      upstreamRequests.push(`${request.method} ${url.pathname}${url.search}`)

      if (url.pathname === "/api/session") {
        if (request.headers.get("authorization") !== basic("opencode", "secret")) {
          return new Response("unauthorized", { status: 401 })
        }
        return Response.json({ data: [{ id: "ses_1" }] })
      }

      if (url.pathname === "/api/event") {
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("data: one\n\n"))
            controller.enqueue(encoder.encode("data: two\n\n"))
            controller.close()
          },
        })
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        })
      }

      return new Response("not found", { status: 404 })
    },
  })
  options.upstream = `http://127.0.0.1:${upstream.port}`
})

afterAll(() => {
  upstream.stop(true)
})

describe("createGateway", () => {
  const gateway = () => createGateway({ options })

  test("rejects a request with no credentials", async () => {
    const response = await gateway()(new Request("http://gateway/api/session"))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Basic")
  })

  test("rejects a wrong password without contacting the upstream", async () => {
    upstreamRequests = []
    const response = await gateway()(
      new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "wrong") } }),
    )
    expect(response.status).toBe(401)
    expect(upstreamRequests).toEqual([])
  })

  test("accepts a correct password, proxies the request, and issues a session cookie", async () => {
    upstreamRequests = []
    const response = await gateway()(
      new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "secret") } }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ id: "ses_1" }] })
    expect(upstreamRequests).toContain("GET /api/session")
    const cookie = response.headers.get("set-cookie")
    expect(cookie).toContain(`${SESSION_COOKIE}=`)
    expect(cookie).toContain("HttpOnly")
  })

  test("rejects a wrong cookie", async () => {
    upstreamRequests = []
    const response = await gateway()(
      new Request("http://gateway/api/session", { headers: { cookie: `${SESSION_COOKIE}=bogus` } }),
    )
    expect(response.status).toBe(401)
    expect(upstreamRequests).toEqual([])
  })

  test("proxies with a valid cookie and injects upstream credentials", async () => {
    const handle = gateway()
    const first = await handle(
      new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "secret") } }),
    )
    const cookie = first.headers.get("set-cookie")!.split(";")[0]
    upstreamRequests = []
    const response = await handle(new Request("http://gateway/api/session?limit=1", { headers: { cookie } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ id: "ses_1" }] })
    expect(upstreamRequests).toEqual(["GET /api/session?limit=1"])
  })

  test("streams SSE without buffering", async () => {
    const handle = gateway()
    const first = await handle(
      new Request("http://gateway/api/health", { headers: { authorization: basic("opencode", "secret") } }),
    )
    const cookie = first.headers.get("set-cookie")!.split(";")[0]
    const response = await handle(new Request("http://gateway/api/event", { headers: { cookie } }))
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n")
  })

  test("strips auth_token from the proxied query", async () => {
    const handle = gateway()
    const first = await handle(
      new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "secret") } }),
    )
    const cookie = first.headers.get("set-cookie")!.split(";")[0]
    upstreamRequests = []
    await handle(new Request("http://gateway/api/session?auth_token=leak&limit=1", { headers: { cookie } }))
    expect(upstreamRequests).toEqual(["GET /api/session?limit=1"])
  })

  test("responds 503 without a cookie when the upstream answers 503", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response("unavailable", { status: 503 }),
    })
    const handle = createGateway({
      options: { ...options, upstream: `http://127.0.0.1:${upstream.port}` },
    })
    const response = await handle(new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "secret") } }))
    upstream.stop(true)
    expect(response.status).toBe(503)
    expect(response.headers.get("www-authenticate")).toBeNull()
    expect(response.headers.get("set-cookie")).toBeNull()
    const rejected = await handle(new Request("http://gateway/api/session", { headers: { cookie: `${SESSION_COOKIE}=whatever` } }))
    expect(rejected.status).toBe(401)
  })

  test("responds 401 with www-authenticate when the upstream rejects the credentials", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 401 }),
    })
    const handle = createGateway({
      options: { ...options, upstream: `http://127.0.0.1:${upstream.port}` },
    })
    const response = await handle(new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "secret") } }))
    upstream.stop(true)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Basic")
  })

  test("responds 503 rather than hanging when the upstream port is closed", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("unused") })
    const closedPort = closed.port
    closed.stop(true)
    const handle = createGateway({
      options: { ...options, upstream: `http://127.0.0.1:${closedPort}` },
    })
    const response = await handle(new Request("http://gateway/api/session", { headers: { authorization: basic("opencode", "secret") } }))
    expect(response.status).toBe(503)
    expect(response.headers.get("www-authenticate")).toBeNull()
  })
})

describe("startGateway", () => {
  test("binds an ephemeral port and stops cleanly", async () => {
    const running = await startGateway({ options, port: 0 })
    expect(running.port).toBeGreaterThan(0)
    const response = await fetch(`http://127.0.0.1:${running.port}/api/session`)
    expect(response.status).toBe(401)
    stopGateway()
    await expect(fetch(`http://127.0.0.1:${running.port}/api/session`)).rejects.toThrow()
  })

  test("reference-counts multiple holders on one port", async () => {
    const first = await startGateway({ options, port: 0 })
    const second = await startGateway({ options, port: 0 })
    expect(second.port).toBe(first.port)
    second.stop()
    const response = await fetch(`http://127.0.0.1:${first.port}/api/session`)
    expect(response.status).toBe(401)
    first.stop()
    await expect(fetch(`http://127.0.0.1:${first.port}/api/session`)).rejects.toThrow()
  })

  test("double stop on the same handle is a no-op", async () => {
    const first = await startGateway({ options, port: 0 })
    const second = await startGateway({ options, port: 0 })
    first.stop()
    first.stop()
    const response = await fetch(`http://127.0.0.1:${first.port}/api/session`)
    expect(response.status).toBe(401)
    second.stop()
    await expect(fetch(`http://127.0.0.1:${first.port}/api/session`)).rejects.toThrow()
  })

  test("force-stops with outstanding refs and restarts cleanly", async () => {
    const first = await startGateway({ options, port: 0 })
    const stale = await startGateway({ options, port: 0 })
    stopGateway()
    await expect(fetch(`http://127.0.0.1:${first.port}/api/session`)).rejects.toThrow()
    const restarted = await startGateway({ options, port: 0 })
    expect(restarted.port).toBeGreaterThan(0)
    const response = await fetch(`http://127.0.0.1:${restarted.port}/api/session`)
    expect(response.status).toBe(401)
    stale.stop()
    const stillUp = await fetch(`http://127.0.0.1:${restarted.port}/api/session`)
    expect(stillUp.status).toBe(401)
    restarted.stop()
    await expect(fetch(`http://127.0.0.1:${restarted.port}/api/session`)).rejects.toThrow()
  })

  test("fully released stale handles do not unregister a restarted server", async () => {
    const first = await startGateway({ options, port: 0 })
    const stale = await startGateway({ options, port: 0 })
    stopGateway()
    const restarted = await startGateway({ options, port: 0 })
    first.stop()
    stale.stop()
    stopGateway()
    await expect(fetch(`http://127.0.0.1:${restarted.port}/api/session`)).rejects.toThrow()
  })

  test("forwards a POST body through the node bridge", async () => {
    const seen: string[] = []
    const echo = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        seen.push(await request.text())
        return new Response("echoed", { headers: { "content-type": "text/plain" } })
      },
    })
    const handle = startGateway({
      options: { host: "127.0.0.1", port: 0, upstream: `http://127.0.0.1:${echo.port}`, username: "opencode", password: "secret", upstreamPassword: "secret" },
    })
    const running = await handle
    const auth = basic("opencode", "secret")
    const response = await fetch(`http://127.0.0.1:${running.port}/api/session`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("echoed")
    expect(seen.filter((body) => body !== "")).toEqual(['{"prompt":"hello"}'])
    stopGateway()
    echo.stop(true)
  })

  test("forwards multiple set-cookie headers", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        const headers = new Headers({ "content-type": "text/plain" })
        headers.append("set-cookie", "a=1; Path=/")
        headers.append("set-cookie", "b=2; Path=/")
        return new Response("ok", { headers })
      },
    })
    const running = await startGateway({
      options: { host: "127.0.0.1", port: 0, upstream: `http://127.0.0.1:${upstream.port}`, username: "opencode", password: "secret", upstreamPassword: "secret" },
    })
    const first = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    const response = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { cookie },
    })
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"])
    stopGateway()
    upstream.stop(true)
  })

  test("streams SSE incrementally through the node bridge", async () => {
    const encoder = new TextEncoder()
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode("data: one\n\n"))
              await Bun.sleep(200)
              controller.enqueue(encoder.encode("data: two\n\n"))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } },
        ),
    })
    const running = await startGateway({
      options: { host: "127.0.0.1", port: 0, upstream: `http://127.0.0.1:${upstream.port}`, username: "opencode", password: "secret", upstreamPassword: "secret" },
    })
    const first = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    const started = Date.now()
    const response = await fetch(`http://127.0.0.1:${running.port}/api/event`, { headers: { cookie } })
    expect(response.headers.get("content-type")).toBe("text/event-stream")

    const reader = response.body!.getReader()
    const firstChunkAt = Date.now()
    const chunk = await reader.read()
    expect(new TextDecoder().decode(chunk.value)).toBe("data: one\n\n")
    expect(firstChunkAt - started).toBeLessThan(150)
    while (!(await reader.read()).done) {}
    stopGateway()
    upstream.stop(true)
  })

  test("never forwards the phone credential to the upstream with distinct passwords", async () => {
    const upstreamAuths: string[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        upstreamAuths.push(request.headers.get("authorization") ?? "")
        if (request.headers.get("authorization") !== basic("opencode", "upstream-pass")) {
          return new Response("nope", { status: 401 })
        }
        return new Response("ok", { headers: { "content-type": "text/plain" } })
      },
    })
    const running = await startGateway({
      options: {
        host: "127.0.0.1",
        port: 0,
        upstream: `http://127.0.0.1:${upstream.port}`,
        username: "opencode",
        password: "phone-pass",
        upstreamPassword: "upstream-pass",
      },
    })
    const phoneAuth = basic("opencode", "phone-pass")
    const upstreamAuthBase64 = Buffer.from("opencode:upstream-pass").toString("base64")

    upstreamAuths.length = 0
    const good = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: phoneAuth },
    })
    expect(good.status).toBe(200)
    expect(upstreamAuths).toEqual([`Basic ${upstreamAuthBase64}`, `Basic ${upstreamAuthBase64}`])
    expect(upstreamAuths.join("\n")).not.toContain(phoneAuth)

    upstreamAuths.length = 0
    const leaked = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: basic("opencode", "upstream-pass") },
    })
    expect(leaked.status).toBe(401)
    expect(upstreamAuths).toEqual([])

    upstreamAuths.length = 0
    const anonymous = await fetch(`http://127.0.0.1:${running.port}/api/health`)
    expect(anonymous.status).toBe(401)
    expect(upstreamAuths).toEqual([])

    const first = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: basic("opencode", "phone-pass") },
    })
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    upstreamAuths.length = 0
    const cookieResponse = await fetch(`http://127.0.0.1:${running.port}/api/health`, { headers: { cookie } })
    expect(cookieResponse.status).toBe(200)
    expect(upstreamAuths).toEqual([`Basic ${upstreamAuthBase64}`])

    stopGateway()
    upstream.stop(true)
  })

  test("responds 503 when the upstream is unreachable", async () => {
    const running = await startGateway({
      options: { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1:1", username: "opencode", password: "secret", upstreamPassword: "secret" },
    })
    const response = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(response.status).toBe(503)
    stopGateway()
  })

  test("survives a malformed Host header without crashing", async () => {
    const running = await startGateway({
      options: { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1:1", username: "opencode", password: "secret", upstreamPassword: "secret" },
    })
    const { connect } = await import("node:net")
    const response = await new Promise<string>((resolve, reject) => {
      let data = ""
      const socket = connect(running.port, "127.0.0.1")
      socket.on("connect", () => {
        socket.write("GET /api/health HTTP/1.1\r\nHost: exa mple\r\nConnection: close\r\n\r\n")
      })
      socket.on("data", (chunk) => {
        data += chunk.toString()
      })
      socket.on("end", () => resolve(data))
      socket.on("error", reject)
      setTimeout(() => reject(new Error("timeout waiting for response")), 10000)
    })
    expect(response).toContain("HTTP/1.1")
    expect(response).toMatch(/HTTP\/1\.1 (400|500)/)
    const after = await fetch(`http://127.0.0.1:${running.port}/api/health`).catch(() => undefined)
    expect(after?.status).toBe(401)
    stopGateway()
  })
})

describe("launcher route", () => {
  const withUpstream = async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        if (request.headers.get("authorization") !== basic("opencode", "secret")) {
          return new Response("unauthorized", { status: 401 })
        }
        if (path === "/api/session/active") return Response.json({ data: {} })
        if (path === "/api/session") {
          return Response.json({
            data: [
              { id: "ses_launcher1", title: "Launcher target", location: { directory: "/work/a" }, time: { updated: 1000 } },
            ],
          })
        }
        return new Response("proxied", { status: 200 })
      },
    })
    const running = await startGateway({
      options: {
        host: "127.0.0.1",
        port: 0,
        upstream: `http://127.0.0.1:${upstream.port}`,
        username: "opencode",
        password: "secret",
        upstreamPassword: "secret",
      },
    })
    return { upstream, running }
  }

  test("requires credentials", async () => {
    const { upstream, running } = await withUpstream()
    const response = await fetch(`http://127.0.0.1:${running.port}/m`)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Basic")
    stopGateway()
    upstream.stop(true)
  })

  test("serves the page for an authenticated request and issues a session cookie", async () => {
    const { upstream, running } = await withUpstream()
    const response = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    const html = await response.text()
    expect(html).toContain("Launcher target")
    expect(html).toContain("/L3dvcmsvYQ/session/ses_launcher1")
    expect(response.headers.getSetCookie()[0]).toContain("oc_mobile_session=")
    stopGateway()
    upstream.stop(true)
  })

  test("treats /m/ the same as /m", async () => {
    const { upstream, running } = await withUpstream()
    const response = await fetch(`http://127.0.0.1:${running.port}/m/`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Sessions")
    stopGateway()
    upstream.stop(true)
  })

  test("serves the page for a valid session cookie without contacting the upstream for auth", async () => {
    const { upstream, running } = await withUpstream()
    const first = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    const response = await fetch(`http://127.0.0.1:${running.port}/m`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Launcher target")
    stopGateway()
    upstream.stop(true)
  })

  test("renders the unreachable page for a cookie holder when the upstream is down", async () => {
    const { upstream, running } = await withUpstream()
    // Establish a session while the upstream is healthy, then take the upstream away.
    const first = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(first.status).toBe(200)
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    upstream.stop(true)

    const response = await fetch(`http://127.0.0.1:${running.port}/m`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain("unreachable")
    expect(html).toContain('href="/m"')
    stopGateway()
  })

  test("rejects a first-time visitor with 503 when the upstream is down", async () => {
    // Without a session cookie the credential probe cannot succeed, so the request
    // never reaches the launcher. The distinct 503 (rather than 401) tells the user
    // the server is down rather than that their password is wrong.
    const running = await startGateway({
      options: {
        host: "127.0.0.1",
        port: 0,
        upstream: "http://127.0.0.1:1",
        username: "opencode",
        password: "secret",
        upstreamPassword: "secret",
      },
    })
    const response = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(response.status).toBe(503)
    expect(response.headers.get("www-authenticate")).toBeNull()
    stopGateway()
  })

  test("renders the unauthorized page when the upstream rejects the gateway credential", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        if (request.headers.get("authorization") !== basic("opencode", "secret")) {
          return new Response("unauthorized", { status: 401 })
        }
        if (url.pathname === "/api/session" && url.searchParams.get("limit") === "1") {
          return Response.json({ data: [] })
        }
        return new Response("unauthorized", { status: 401 })
      },
    })
    const running = await startGateway({
      options: {
        host: "127.0.0.1",
        port: 0,
        upstream: `http://127.0.0.1:${upstream.port}`,
        username: "opencode",
        password: "secret",
        upstreamPassword: "secret",
      },
    })
    const response = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain("rejected the gateway")
    expect(html).not.toContain("unreachable")
    expect(response.headers.get("www-authenticate")).toBeNull()
    stopGateway()
    upstream.stop(true)
  })

  test("still proxies other paths", async () => {
    const { upstream, running } = await withUpstream()
    const first = await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    const cookie = first.headers.getSetCookie()[0].split(";")[0]
    const response = await fetch(`http://127.0.0.1:${running.port}/api/health`, { headers: { cookie } })
    expect(await response.text()).toBe("proxied")
    stopGateway()
    upstream.stop(true)
  })

  test("does not proxy the launcher path upstream", async () => {
    const paths: string[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        paths.push(path)
        if (path === "/api/session/active") return Response.json({ data: {} })
        if (path === "/api/session") return Response.json({ data: [] })
        return new Response("proxied")
      },
    })
    const running = await startGateway({
      options: {
        host: "127.0.0.1",
        port: 0,
        upstream: `http://127.0.0.1:${upstream.port}`,
        username: "opencode",
        password: "secret",
        upstreamPassword: "secret",
      },
    })
    await fetch(`http://127.0.0.1:${running.port}/m`, {
      headers: { authorization: basic("opencode", "secret") },
    })
    expect(paths).not.toContain("/m")
    stopGateway()
    upstream.stop(true)
  })
})