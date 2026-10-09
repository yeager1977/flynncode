import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { GatewayOptions } from "../src/config.ts"
import { createGateway } from "../src/gateway.ts"
import { createSyncGate, type SyncPeer } from "../src/sync-gate.ts"
import { pairWithPeer, peerBaseUrl, unpairPeer } from "../src/sync-pair.ts"

const basic = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`

let upstream: ReturnType<typeof Bun.serve>
const upstreamPaths: string[] = []
const options: GatewayOptions = {
  host: "127.0.0.1",
  port: 0,
  upstream: "",
  username: "opencode",
  password: "phone",
  upstreamPassword: "server",
  relayToken: "",
}

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      upstreamPaths.push(url.pathname)
      if (request.headers.get("authorization") !== basic("opencode", "server")) return new Response("no", { status: 401 })
      if (url.pathname === "/api/session") return Response.json({ data: [] })
      return Response.json({ path: url.pathname })
    },
  })
  options.upstream = `http://127.0.0.1:${upstream.port}`
})

afterAll(() => upstream.stop(true))

const peer: SyncPeer = { name: "starship", url: "http://192.168.1.20:4097", token: "a".repeat(64) }

function gate(input: { phoneAccess?: boolean; peer?: SyncPeer; paused?: boolean } = {}) {
  const events: string[] = []
  const value = createSyncGate({
    machineName: "challenger",
    gatewayPort: 4097,
    phoneAccess: input.phoneAccess ?? false,
    paused: input.paused ?? false,
    peer: input.peer,
    prefs: { sections: { appearance: { fontSize: 15 } }, updatedAt: 7 },
    token: () => "b".repeat(64),
    onPaired: (paired) => events.push(`paired:${paired.name}:${paired.url}`),
    onUnpaired: () => events.push("unpaired"),
  })
  return { value, events }
}

const pairRequest = (code: string) =>
  new Request("http://gateway/flynncode-sync/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "starship" }),
  })

describe("pairing", () => {
  test("a valid code mints a token and records the caller as the peer", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    const handle = createGateway({ options, sync: sync.value })
    const response = await handle(pairRequest("482913"), "::ffff:192.168.1.20")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ token: "b".repeat(64), name: "challenger" })
    expect(sync.value.peer()).toEqual({ name: "starship", url: "http://192.168.1.20:4097", token: "b".repeat(64) })
    expect(sync.events).toEqual(["paired:starship:http://192.168.1.20:4097"])
    expect(sync.value.pairingActive()).toBe(false)
  })

  test("wrong codes are rejected and five failures burn the code", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    const handle = createGateway({ options, sync: sync.value })
    const statuses = []
    for (const attempt of [1, 2, 3, 4, 5]) statuses.push((await handle(pairRequest(`00000${attempt}`), "192.168.1.20")).status)
    expect(statuses).toEqual([403, 403, 403, 403, 429])
    expect((await handle(pairRequest("482913"), "192.168.1.20")).status).toBe(403)
  })

  test("an expired code is rejected", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "482913", expiresAt: Date.now() - 1 })
    const handle = createGateway({ options, sync: sync.value })
    expect((await handle(pairRequest("482913"), "192.168.1.20")).status).toBe(403)
  })
})

describe("token-gated sync routes", () => {
  test("require the pairing token; the phone password does not open them", async () => {
    const handle = createGateway({ options, sync: gate({ peer, phoneAccess: true }).value })
    const manifest = "http://gateway/flynncode-sync/manifest"
    expect((await handle(new Request(manifest), "192.168.1.20")).status).toBe(401)
    expect(
      (await handle(new Request(manifest, { headers: { authorization: basic("opencode", "phone") } }), "192.168.1.20")).status,
    ).toBe(401)
    const ok = await handle(new Request(manifest, { headers: { authorization: `Bearer ${peer.token}` } }), "192.168.1.20")
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ path: "/flynncode-sync/manifest" })
  })

  test("forward only the read-only allowlist and count bundles sent", async () => {
    const sync = gate({ peer })
    const handle = createGateway({ options, sync: sync.value })
    const auth = { authorization: `Bearer ${peer.token}` }
    expect((await handle(new Request("http://gateway/flynncode-sync/session/ses_1", { headers: auth }), undefined)).status).toBe(200)
    expect((await handle(new Request("http://gateway/flynncode-sync/settings", { headers: auth }), undefined)).status).toBe(200)
    expect((await handle(new Request("http://gateway/flynncode-sync/missing", { headers: auth }), undefined)).status).toBe(404)
    expect(
      (await handle(new Request("http://gateway/flynncode-sync/apply", { method: "POST", headers: auth, body: "{}" }), undefined)).status,
    ).toBe(405)
    expect(sync.value.takeSent()).toBe(1)
    expect(sync.value.takeSent()).toBe(0)
  })

  test("serve prefs from the gate and stop serving while paused", async () => {
    const auth = { authorization: `Bearer ${peer.token}` }
    const live = createGateway({ options, sync: gate({ peer }).value })
    const prefs = await live(new Request("http://gateway/flynncode-sync/prefs", { headers: auth }), undefined)
    expect(await prefs.json()).toEqual({ prefs: { sections: { appearance: { fontSize: 15 } }, updatedAt: 7 } })
    const paused = createGateway({ options, sync: gate({ peer, paused: true }).value })
    expect((await paused(new Request("http://gateway/flynncode-sync/manifest", { headers: auth }), undefined)).status).toBe(503)
  })

  test("unpair revokes the token", async () => {
    const sync = gate({ peer })
    const handle = createGateway({ options, sync: sync.value })
    const response = await handle(
      new Request("http://gateway/flynncode-sync/unpair", { method: "POST", headers: { authorization: `Bearer ${peer.token}` } }),
      undefined,
    )
    expect(response.status).toBe(200)
    expect(sync.value.peer()).toBeUndefined()
    expect(sync.events).toEqual(["unpaired"])
  })

  test("a gateway without a sync gate serves no sync routes", async () => {
    const handle = createGateway({ options })
    expect((await handle(new Request("http://gateway/flynncode-sync/manifest"), undefined)).status).toBe(404)
  })
})

describe("phone access gating", () => {
  test("with phone access off every phone route answers 404 and sync still works", async () => {
    const handle = createGateway({ options, sync: gate({ peer, phoneAccess: false }).value })
    const phone = { authorization: basic("opencode", "phone") }
    expect((await handle(new Request("http://gateway/flynncode-mobile-status"), "127.0.0.1")).status).toBe(404)
    expect((await handle(new Request("http://gateway/m", { headers: phone }), "192.168.1.20")).status).toBe(404)
    expect((await handle(new Request("http://gateway/flynncode-mobile-inbox", { headers: phone }), "192.168.1.20")).status).toBe(404)
    expect((await handle(new Request("http://gateway/flynncode-mobile-relay/inbox", { headers: phone }), "192.168.1.20")).status).toBe(404)
    expect((await handle(new Request("http://gateway/api/session", { headers: phone }), "192.168.1.20")).status).toBe(404)
    const sync = await handle(
      new Request("http://gateway/flynncode-sync/manifest", { headers: { authorization: `Bearer ${peer.token}` } }),
      "192.168.1.20",
    )
    expect(sync.status).toBe(200)
  })

  test("turning phone access on takes effect on the next request", async () => {
    const sync = gate({ phoneAccess: false })
    const handle = createGateway({ options, sync: sync.value })
    expect((await handle(new Request("http://gateway/flynncode-mobile-status"), "127.0.0.1")).status).toBe(404)
    sync.value.update({ phoneAccess: true })
    expect((await handle(new Request("http://gateway/flynncode-mobile-status"), "127.0.0.1")).status).toBe(200)
  })
})

describe("pairing client", () => {
  test("builds peer URLs from a host, host:port or URL", () => {
    expect(peerBaseUrl("starship.local")).toBe("http://starship.local:4097")
    expect(peerBaseUrl("192.168.1.20:5000")).toBe("http://192.168.1.20:5000")
    expect(peerBaseUrl("http://192.168.1.20:4097/")).toBe("http://192.168.1.20:4097")
  })

  test("pairs against a real gateway and unpairs again", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "135790", expiresAt: Date.now() + 60_000 })
    const handle = createGateway({ options, sync: sync.value })
    const server = Bun.serve({ port: 0, fetch: (request, srv) => handle(request, srv.requestIP(request)?.address) })
    const host = `127.0.0.1:${server.port}`
    expect(await pairWithPeer({ host, code: "000000", name: "starship" })).toEqual({ ok: false, reason: "invalid-code" })
    const result = await pairWithPeer({ host, code: "135790", name: "starship" })
    expect(result).toEqual({ ok: true, peer: { name: "challenger", url: `http://${host}`, token: "b".repeat(64) } })
    if (result.ok) await unpairPeer({ peer: result.peer })
    expect(sync.value.peer()).toBeUndefined()
    server.stop(true)
    expect(await pairWithPeer({ host: "127.0.0.1:9", code: "135790", name: "starship" })).toEqual({ ok: false, reason: "unreachable" })
  })
})
