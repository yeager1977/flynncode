import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createGateway, startGateway, stopGateway } from "../src/gateway"
import { SESSION_COOKIE, sessionCookie } from "../src/cookies"
import type { GatewayOptions } from "../src/config"

const options: GatewayOptions = {
  host: "127.0.0.1",
  port: 0,
  upstream: "",
  username: "opencode",
  password: "secret",
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
})