import { describe, expect, test } from "bun:test"
import { Upstream, upstreamHeaders, upstreamUrl } from "../src/upstream"

describe("upstreamUrl", () => {
  test("keeps path and query", () => {
    expect(upstreamUrl("http://127.0.0.1:4096", "http://gateway:4097/api/session?limit=1").href).toBe(
      "http://127.0.0.1:4096/api/session?limit=1",
    )
  })

  test("preserves a base path prefix", () => {
    expect(upstreamUrl("http://127.0.0.1:4096/base", "http://gateway:4097/api/health").href).toBe(
      "http://127.0.0.1:4096/base/api/health",
    )
  })

  test("strips auth_token from the query", () => {
    expect(upstreamUrl("http://127.0.0.1:4096", "http://gateway:4097/api/session?auth_token=abc&limit=1").href).toBe(
      "http://127.0.0.1:4096/api/session?limit=1",
    )
  })
})

describe("upstreamHeaders", () => {
  test("replaces authorization and drops host and cookie", () => {
    const headers = upstreamHeaders({
      base: "http://127.0.0.1:4096",
      authorization: "Basic env",
      incoming: { host: "gateway:4097", cookie: "oc_mobile_session=x", accept: "application/json" },
    })
    expect(headers.authorization).toBe("Basic env")
    expect(headers.accept).toBe("application/json")
    expect(headers.host).toBeUndefined()
    expect(headers.cookie).toBeUndefined()
  })

  test("drops a mixed-case authorization from incoming", () => {
    const headers = upstreamHeaders({
      base: "http://127.0.0.1:4096",
      authorization: "Basic env",
      incoming: { Authorization: "Bearer stale", accept: "application/json" },
    })
    expect(Object.keys(headers).sort()).toEqual(["accept", "authorization"])
    expect(headers.authorization).toBe("Basic env")
  })
})

describe("Upstream.probe", () => {
  test("returns false on 401", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 401 }),
    })
    const ok = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic wrong" })
    server.stop(true)
    expect(ok).toBe(false)
  })

  test("returns true on 200", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ data: [] }),
    })
    const ok = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic right" })
    server.stop(true)
    expect(ok).toBe(true)
  })

  test("returns false when upstream is unreachable", async () => {
    const ok = await Upstream.probe({ base: "http://127.0.0.1:1", authorization: "Basic right" })
    expect(ok).toBe(false)
  })

  test("returns false when a redirect is refused", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 302 }),
    })
    const ok = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic right" })
    server.stop(true)
    expect(ok).toBe(false)
  })

  test("returns false on non-2xx status", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("unavailable", { status: 503 }),
    })
    const ok = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic right" })
    server.stop(true)
    expect(ok).toBe(false)
  })

  test("returns false on redirect to a 200 page", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/api/session") {
          return new Response(null, { status: 302, headers: { location: "/login" } })
        }
        return Response.json({ data: [] })
      },
    })
    const ok = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic right" })
    server.stop(true)
    expect(ok).toBe(false)
  })
})