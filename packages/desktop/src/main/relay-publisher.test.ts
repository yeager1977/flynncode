import { expect, test } from "bun:test"
import { buildDigestBody, relayPublisherConfigFromEnv, startRelayPublisher } from "./relay-publisher.ts"
import { createGateway } from "@flynncode/mobile-gateway/gateway"

test("digest body carries metadata only", () => {
  const body = buildDigestBody({
    originID: "laptop",
    items: [{ sessionID: "ses_1", directory: "/repo", title: "Fix", kind: "permission", updated: 5 }],
    updatedAt: 7,
  })
  expect(body).toEqual({ originID: "laptop", items: [{ sessionID: "ses_1", directory: "/repo", title: "Fix", kind: "permission", updated: 5 }], updatedAt: 7 })
})

test("sidecar config uses the outbound remote token, not the inbound one", () => {
  const config = relayPublisherConfigFromEnv(
    { OPENCODE_RELAY_TOKEN: "local-inbound", OPENCODE_RELAY_REMOTE_TOKEN: "deep-B", OPENCODE_RELAY_URL: "http://192.168.4.251:4097/" },
    { gatewayPort: 4097, phonePassword: "phone-A", originID: "laptop-A" },
  )
  expect(config?.remoteToken).toBe("deep-B")
  expect(config?.remotePublishUrl).toBe("http://192.168.4.251:4097/flynncode-mobile-relay/publish")
})

test("sidecar config stays off without a remote token", () => {
  const config = relayPublisherConfigFromEnv(
    { OPENCODE_RELAY_TOKEN: "local-inbound", OPENCODE_RELAY_URL: "http://192.168.4.251:4097" },
    { gatewayPort: 4097, phonePassword: "phone-A", originID: "laptop-A" },
  )
  expect(config).toBeUndefined()
})

async function waitFor(condition: () => boolean, ms = 5000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for relay publish")
    await Bun.sleep(25)
  }
}

test("publisher authenticates with the remote token when it differs from the local token", async () => {
  const deepthought = createGateway({
    options: { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1:1", username: "opencode", password: "phone", upstreamPassword: "up", relayToken: "deep-B" },
  })
  const statuses: number[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/flynncode-mobile-inbox") {
        return Response.json({ items: [{ sessionID: "ses_9", directory: "/r", title: "Fix", kind: "permission", updated: 1 }] })
      }
      if (url.pathname === "/flynncode-mobile-relay/publish") {
        const forwarded = new Request("http://relay/flynncode-mobile-relay/publish", {
          method: "POST",
          headers: { authorization: request.headers.get("authorization") ?? "", "content-type": "application/json" },
          body: await request.arrayBuffer(),
        })
        const result = await deepthought(forwarded)
        statuses.push(result.status)
        return new Response(await result.text(), { status: result.status })
      }
      return new Response("not found", { status: 404 })
    },
  })
  const publisher = startRelayPublisher({
    originID: "laptop-A",
    pollMs: 50,
    localInboxUrl: `http://127.0.0.1:${server.port}/flynncode-mobile-inbox`,
    remotePublishUrl: `http://127.0.0.1:${server.port}/flynncode-mobile-relay/publish`,
    phonePassword: "phone-A",
    remoteToken: "deep-B",
  })
  await waitFor(() => statuses.includes(200))
  publisher.stop()
  server.stop(true)
  expect(statuses).toContain(200)
})

test("publisher with the wrong remote token gets 403 and stores nothing", async () => {
  const deepthought = createGateway({
    options: { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1:1", username: "opencode", password: "phone", upstreamPassword: "up", relayToken: "deep-B" },
  })
  const statuses: number[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/flynncode-mobile-inbox") {
        return Response.json({ items: [{ sessionID: "ses_9", directory: "/r", title: "Fix", kind: "permission", updated: 1 }] })
      }
      if (url.pathname === "/flynncode-mobile-relay/publish") {
        const forwarded = new Request("http://relay/flynncode-mobile-relay/publish", {
          method: "POST",
          headers: { authorization: request.headers.get("authorization") ?? "", "content-type": "application/json" },
          body: await request.arrayBuffer(),
        })
        const result = await deepthought(forwarded)
        statuses.push(result.status)
        return new Response(await result.text(), { status: result.status })
      }
      return new Response("not found", { status: 404 })
    },
  })
  const publisher = startRelayPublisher({
    originID: "laptop-A-wrong",
    pollMs: 50,
    localInboxUrl: `http://127.0.0.1:${server.port}/flynncode-mobile-inbox`,
    remotePublishUrl: `http://127.0.0.1:${server.port}/flynncode-mobile-relay/publish`,
    phonePassword: "phone-A",
    remoteToken: "wrong",
  })
  await waitFor(() => statuses.includes(403))
  publisher.stop()
  server.stop(true)
  expect(statuses).not.toContain(200)
})
