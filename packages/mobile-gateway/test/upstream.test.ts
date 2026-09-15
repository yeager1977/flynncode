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
  test("classifies 401 as unauthorized", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 401 }),
    })
    const result = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic wrong" })
    server.stop(true)
    expect(result).toEqual({ ok: false, reason: "unauthorized" })
  })

  test("returns ok on 200", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ data: [] }),
    })
    const result = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic right" })
    server.stop(true)
    expect(result).toEqual({ ok: true })
  })

  test("classifies an unreachable upstream as unreachable", async () => {
    const result = await Upstream.probe({ base: "http://127.0.0.1:1", authorization: "Basic right" })
    expect(result).toEqual({ ok: false, reason: "unreachable" })
  })

  test("classifies a refused redirect as unreachable", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 302 }),
    })
    const result = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic right" })
    server.stop(true)
    expect(result).toEqual({ ok: false, reason: "unreachable" })
  })

  test("classifies a non-2xx status as unreachable", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("unavailable", { status: 503 }),
    })
    const result = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic right" })
    server.stop(true)
    expect(result).toEqual({ ok: false, reason: "unreachable" })
  })

  test("classifies a redirect to a 200 page as unreachable", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/api/session") {
          return new Response(null, { status: 302, headers: { location: "/login" } })
        }
        return Response.json({ data: [] })
      },
    })
    const result = await Upstream.probe({ base: `http://127.0.0.1:${server.port}`, authorization: "Basic right" })
    server.stop(true)
    expect(result).toEqual({ ok: false, reason: "unreachable" })
  })
})