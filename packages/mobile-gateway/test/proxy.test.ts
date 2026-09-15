import { describe, expect, test } from "bun:test"
import { proxyResponseHeaders, streamThrough } from "../src/proxy"

describe("proxyResponseHeaders", () => {
  test("strips transfer metadata but keeps content type", () => {
    const source = new Headers({
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": "123",
      "transfer-encoding": "chunked",
      "cache-control": "no-cache",
    })
    const result = proxyResponseHeaders(source)
    expect(result.get("content-type")).toBe("application/json")
    expect(result.get("cache-control")).toBe("no-cache")
    expect(result.get("content-encoding")).toBeNull()
    expect(result.get("content-length")).toBeNull()
    expect(result.get("transfer-encoding")).toBeNull()
  })
})

describe("streamThrough", () => {
  test("delivers chunks without buffering the whole body", async () => {
    const encoder = new TextEncoder()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first\n"))
      },
      async pull(controller) {
        await gate
        controller.enqueue(encoder.encode("second\n"))
        controller.close()
      },
    })
    const upstream = new Response(body, { headers: { "content-type": "text/event-stream" } })
    const result = streamThrough(upstream)

    const reader = result.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe("first\n")
    release()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe("second\n")
  })

  test("returns an empty body when upstream has none", () => {
    const upstream = new Response(null, { status: 204 })
    const result = streamThrough(upstream)
    expect(result.body).toBeNull()
    expect(result.status).toBe(204)
  })
})