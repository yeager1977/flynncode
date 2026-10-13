import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { GatewayOptions } from "../src/config.ts"
import { createGateway } from "../src/gateway.ts"
import { createSyncGate, type SyncPeer } from "../src/sync-gate.ts"
import { handleSync } from "../src/sync-routes.ts"
import { pairWithPeer, peerBaseUrl, unpairPeer } from "../src/sync-pair.ts"
import {
  SYNC_RESPONSE_SIGNATURE_HEADER,
  signRequest,
  signResponse,
  signedRequest,
  verifyResponse,
} from "../src/sync-sign.ts"

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

// A request from the paired machine, signed with the token the way the worker signs it.
function fromPeer(
  path: string,
  init: { method?: string; body?: string; token?: string; now?: number; nonce?: string } = {},
) {
  const url = new URL(path, "http://gateway")
  const method = init.method ?? "GET"
  const signed = signRequest({
    token: init.token ?? peer.token,
    method,
    target: url.pathname + url.search,
    body: init.body,
    now: init.now,
    nonce: init.nonce,
  })
  return new Request(url, { method, headers: signed.headers, body: init.body })
}

function gate(input: { phoneAccess?: boolean; peer?: SyncPeer; paused?: boolean; hubMode?: boolean } = {}) {
  const events: string[] = []
  const value = createSyncGate({
    machineName: "challenger",
    gatewayPort: 4097,
    phoneAccess: input.phoneAccess ?? false,
    paused: input.paused ?? false,
    hubMode: input.hubMode ?? false,
    peer: input.peer,
    prefs: { sections: { appearance: { fontSize: 15 } }, updatedAt: 7 },
    token: () => "b".repeat(64),
    onPaired: (paired) => events.push(`paired:${paired.name}:${paired.url}`),
    onUnpaired: () => events.push("unpaired"),
  })
  return { value, events }
}

const pairRequest = (code: string, extra: Record<string, unknown> = {}) =>
  new Request("http://gateway/flynncode-sync/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "starship", ...extra }),
  })

// A body that never ends and records whether anyone read from it.
function endlessBody() {
  const state = { read: 0 }
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.read += 1
        controller.enqueue(new Uint8Array(1024).fill(65))
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, state }
}

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

describe("pairing hardening", () => {
  test("answers 403 without reading the body while no code is waiting", async () => {
    const handle = createGateway({ options, sync: gate().value })
    const body = endlessBody()
    const response = await handle(
      new Request("http://gateway/flynncode-sync/pair", { method: "POST", body: body.stream, duplex: "half" } as RequestInit),
      "192.168.1.20",
    )
    expect(response.status).toBe(403)
    expect(body.state.read).toBe(0)
  })

  test("stops reading a chunked body past 4 KiB", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    const handle = createGateway({ options, sync: sync.value })
    const body = endlessBody()
    const response = await handle(
      new Request("http://gateway/flynncode-sync/pair", { method: "POST", body: body.stream, duplex: "half" } as RequestInit),
      "192.168.1.20",
    )
    expect(response.status).toBe(413)
    expect(body.state.read).toBeLessThanOrEqual(6)
    expect(sync.value.peer()).toBeUndefined()
  })

  test("stops reading an oversized chunked body sent over a real socket", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    const handle = createGateway({ options, sync: sync.value })
    const server = Bun.serve({ port: 0, fetch: (request, srv) => handle(request, srv.requestIP(request)?.address) })
    const body = endlessBody()
    const response = await fetch(`http://127.0.0.1:${server.port}/flynncode-sync/pair`, {
      method: "POST",
      body: body.stream,
      duplex: "half",
    } as RequestInit).catch(() => undefined)
    // Either the 413 arrives or the server hangs up mid-upload; it never waits for the end.
    if (response) expect(response.status).toBe(413)
    server.stop(true)
  })

  test("refuses pairing when the caller's address is unknown", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    const handle = createGateway({ options, sync: sync.value })
    expect((await handle(pairRequest("482913"), undefined)).status).toBe(400)
    expect(sync.value.peer()).toBeUndefined()
  })

  test("pairs a link-local IPv6 caller through the address it advertised", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    const handle = createGateway({ options, sync: sync.value })
    const response = await handle(
      pairRequest("482913", { host: "starship", addresses: ["not-an-ip", "192.168.1.30"] }),
      "fe80::1c2b:3a4d%eth0",
    )
    expect(response.status).toBe(200)
    expect(sync.value.peer()?.url).toBe("http://192.168.1.30:4097")
    expect(() => new URL(sync.value.peer()?.url ?? "")).not.toThrow()
  })

  test("pairs a routable IPv6 caller with a bracketed URL and falls back to the advertised name", async () => {
    const routable = gate()
    routable.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    await createGateway({ options, sync: routable.value })(pairRequest("482913"), "2001:db8::20")
    expect(routable.value.peer()?.url).toBe("http://[2001:db8::20]:4097")

    const named = gate()
    named.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    await createGateway({ options, sync: named.value })(pairRequest("482913", { host: "starship" }), "fe80::1%wlan0")
    expect(named.value.peer()?.url).toBe("http://starship:4097")

    const nowhere = gate()
    nowhere.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    const refused = await createGateway({ options, sync: nowhere.value })(pairRequest("482913"), "fe80::1%wlan0")
    expect(refused.status).toBe(400)
  })
})

describe("peer address refresh", () => {
  test("follows the socket address of requests that carry the token", async () => {
    const moved: string[] = []
    const value = createSyncGate({
      machineName: "challenger",
      gatewayPort: 4097,
      phoneAccess: false,
      paused: false,
      peer: { ...peer, url: "http://192.168.1.20:5000" },
      prefs: undefined,
      onPeerMoved: (next) => moved.push(next.url),
    })
    const handle = createGateway({ options, sync: value })
    const manifest = "http://gateway/flynncode-sync/manifest"
    // A caller without the token never moves the peer.
    await handle(new Request(manifest), "192.168.1.66")
    expect(value.peer()?.url).toBe("http://192.168.1.20:5000")
    await handle(fromPeer(manifest), "::ffff:192.168.1.21")
    // The host follows; the stored port stays.
    expect(value.peer()?.url).toBe("http://192.168.1.21:5000")
    // A zoned link-local address has no URL form, so the last good address stays.
    await handle(fromPeer(manifest), "fe80::1%eth0")
    await handle(fromPeer(manifest), "192.168.1.21")
    expect(moved).toEqual(["http://192.168.1.21:5000"])
  })

  test("keeps a peer stored under a host name", async () => {
    const value = createSyncGate({
      machineName: "challenger",
      gatewayPort: 4097,
      phoneAccess: false,
      paused: false,
      peer: { ...peer, url: "http://starship.local:4097" },
      prefs: undefined,
    })
    const handle = createGateway({ options, sync: value })
    await handle(
      fromPeer("http://gateway/flynncode-sync/manifest"),
      "192.168.1.21",
    )
    expect(value.peer()?.url).toBe("http://starship.local:4097")
  })

  test("never authorizes a stored token that is empty or malformed", async () => {
    for (const token of ["", "short", "Z".repeat(64)]) {
      const handle = createGateway({ options, sync: gate({ peer: { ...peer, token } }).value })
      const response = await handle(
        fromPeer("http://gateway/flynncode-sync/manifest", { token }),
        "192.168.1.20",
      )
      expect(response.status).toBe(401)
    }
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
    const ok = await handle(fromPeer(manifest), "192.168.1.20")
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ path: "/flynncode-sync/manifest" })
  })

  test("forward only the read-only allowlist and count bundles sent", async () => {
    const sync = gate({ peer })
    const handle = createGateway({ options, sync: sync.value })
    expect((await handle(fromPeer("http://gateway/flynncode-sync/session/ses_1"), undefined)).status).toBe(200)
    expect((await handle(fromPeer("http://gateway/flynncode-sync/settings"), undefined)).status).toBe(200)
    expect((await handle(fromPeer("http://gateway/flynncode-sync/missing"), undefined)).status).toBe(404)
    expect(
      (await handle(fromPeer("http://gateway/flynncode-sync/apply", { method: "POST", body: "{}" }), undefined)).status,
    ).toBe(404)
    expect(sync.value.takeSent()).toBe(1)
    expect(sync.value.takeSent()).toBe(0)
  })

  test("never forward write routes, encoded or dot-segment paths, or HEAD and OPTIONS", async () => {
    const handle = createGateway({ options, sync: gate({ peer }).value })
    const before = upstreamPaths.length
    const attempts: Array<[string, string]> = [
      ["GET", "/flynncode-sync/apply"],
      ["POST", "/flynncode-sync/apply"],
      ["GET", "/flynncode-sync/missing"],
      ["POST", "/flynncode-sync/delete/ses_1"],
      ["GET", "/flynncode-sync/delete/ses_1"],
      ["POST", "/flynncode-sync/archive/ses_1"],
      ["GET", "/flynncode-sync/archive/ses_1"],
      ["GET", "/flynncode-sync/session/ses_1/../../apply"],
      ["GET", "/flynncode-sync/session/%2e%2e/%2e%2e/apply"],
      ["GET", "/flynncode-sync/session/ses_1%2F..%2F..%2Fapply"],
      ["GET", "/flynncode-sync/session/ses_1%2Fextra"],
      ["GET", "/flynncode-sync//manifest"],
      ["HEAD", "/flynncode-sync/manifest"],
      ["OPTIONS", "/flynncode-sync/manifest"],
    ]
    for (const [method, path] of attempts) {
      const response = await handle(
        fromPeer(`http://gateway${path}`, { method, body: method === "POST" ? "{}" : undefined }),
        "192.168.1.20",
      )
      expect([404, 405]).toContain(response.status)
    }
    expect(upstreamPaths.length).toBe(before)
  })

  test("answer 502, not 401, when the local server refuses the gateway", async () => {
    const handle = createGateway({ options: { ...options, upstreamPassword: "wrong" }, sync: gate({ peer }).value })
    const response = await handle(
      fromPeer("http://gateway/flynncode-sync/manifest"),
      "192.168.1.20",
    )
    expect(response.status).toBe(502)
  })

  test("serve prefs from the gate and stop serving while paused", async () => {
    const live = createGateway({ options, sync: gate({ peer }).value })
    const prefs = await live(fromPeer("http://gateway/flynncode-sync/prefs"), undefined)
    expect(await prefs.json()).toEqual({ prefs: { sections: { appearance: { fontSize: 15 } }, updatedAt: 7 } })
    const paused = createGateway({ options, sync: gate({ peer, paused: true }).value })
    expect((await paused(fromPeer("http://gateway/flynncode-sync/manifest"), undefined)).status).toBe(503)
  })

  test("unpair revokes the token", async () => {
    const sync = gate({ peer })
    const handle = createGateway({ options, sync: sync.value })
    const response = await handle(
      fromPeer("http://gateway/flynncode-sync/unpair", { method: "POST" }),
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

describe("signed sync requests", () => {
  const manifest = "http://gateway/flynncode-sync/manifest"

  test("never accept the token itself as a credential", async () => {
    const handle = createGateway({ options, sync: gate({ peer }).value })
    const bearer = new Request(manifest, { headers: { authorization: `Bearer ${peer.token}` } })
    expect((await handle(bearer, "192.168.1.20")).status).toBe(401)
  })

  test("reject a replayed request", async () => {
    const handle = createGateway({ options, sync: gate({ peer }).value })
    const nonce = "1".repeat(32)
    expect((await handle(fromPeer(manifest, { nonce }), "192.168.1.20")).status).toBe(200)
    expect((await handle(fromPeer(manifest, { nonce }), "192.168.1.20")).status).toBe(401)
  })

  test("reject a request signed more than a minute away from now", async () => {
    const handle = createGateway({ options, sync: gate({ peer }).value })
    expect((await handle(fromPeer(manifest, { now: Date.now() - 61_000 }), "192.168.1.20")).status).toBe(401)
    expect((await handle(fromPeer(manifest, { now: Date.now() + 61_000 }), "192.168.1.20")).status).toBe(401)
    expect((await handle(fromPeer(manifest, { now: Date.now() - 30_000 }), "192.168.1.20")).status).toBe(200)
  })

  test("reject a request whose path, query, method or body was altered", async () => {
    const sync = gate({ peer })
    const handle = createGateway({ options, sync: sync.value })
    const signedFor = fromPeer(manifest)
    const elsewhere = new Request("http://gateway/flynncode-sync/settings", { headers: signedFor.headers })
    expect((await handle(elsewhere, "192.168.1.20")).status).toBe(401)
    const query = new Request(`${manifest}?x=1`, { headers: fromPeer(manifest).headers })
    expect((await handle(query, "192.168.1.20")).status).toBe(401)
    const unpair = fromPeer("http://gateway/flynncode-sync/unpair", { method: "POST" })
    const withBody = new Request(unpair.url, { method: "POST", headers: unpair.headers, body: "{}" })
    expect((await handle(withBody, "192.168.1.20")).status).toBe(401)
    const asPost = new Request(manifest, { method: "POST", headers: fromPeer(manifest).headers })
    expect((await handle(asPost, "192.168.1.20")).status).toBe(401)
    expect((await handle(fromPeer(manifest, { token: "f".repeat(64) }), "192.168.1.20")).status).toBe(401)
    expect(sync.value.peer()).toEqual(peer)
  })

  test("sign the answer over the request nonce and the body", async () => {
    const handle = createGateway({ options, sync: gate({ peer }).value })
    const nonce = "2".repeat(32)
    const response = await handle(fromPeer(manifest, { nonce }), "192.168.1.20")
    const body = new Uint8Array(await response.arrayBuffer())
    expect(response.headers.get(SYNC_RESPONSE_SIGNATURE_HEADER)).toBe(signResponse(peer.token, nonce, 200, body))
    expect(response.headers.get(SYNC_RESPONSE_SIGNATURE_HEADER)).not.toBe(signResponse(peer.token, nonce, 503, body))
  })

  test("sign a refusal only for requests signed with the current or a revoked token", async () => {
    const sync = gate({ peer })
    const handle = createGateway({ options, sync: sync.value })
    const refusal = async (request: Request, nonce: string, token: string) => {
      const response = await handle(request, "192.168.1.20")
      const body = new Uint8Array(await response.arrayBuffer())
      const signature = response.headers.get(SYNC_RESPONSE_SIGNATURE_HEADER)
      return {
        status: response.status,
        verified: verifyResponse(token, nonce, response.status, body, signature),
        body: JSON.parse(new TextDecoder().decode(body)) as { error: string; now?: number },
      }
    }
    // A stale request signed with the token: signed 401 with the gateway's clock.
    const stale = await refusal(fromPeer(manifest, { nonce: "5".repeat(32), now: Date.now() - 120_000 }), "5".repeat(32), peer.token)
    expect(stale.status).toBe(401)
    expect(stale.verified).toBe(true)
    expect(stale.body.error).toBe("clock")
    expect(Math.abs((stale.body.now ?? 0) - Date.now())).toBeLessThan(5_000)
    // A replay: signed, but no use to an attacker.
    await handle(fromPeer(manifest, { nonce: "6".repeat(32) }), "192.168.1.20")
    expect((await refusal(fromPeer(manifest, { nonce: "6".repeat(32) }), "6".repeat(32), peer.token)).body.error).toBe(
      "replay",
    )
    // Unknown token: unsigned.
    const stranger = await refusal(fromPeer(manifest, { nonce: "7".repeat(32), token: "f".repeat(64) }), "7".repeat(32), "f".repeat(64))
    expect(stranger.status).toBe(401)
    expect(stranger.verified).toBe(false)
    // After unpair the old token still gets a signed "revoked", so the peer knows to pair again.
    sync.value.revoke()
    const revoked = await refusal(fromPeer(manifest, { nonce: "8".repeat(32) }), "8".repeat(32), peer.token)
    expect(revoked).toMatchObject({ status: 401, verified: true, body: { error: "revoked" } })
  })

  test("a re-paired gateway tells the previous peer it was revoked", async () => {
    const sync = gate({ peer })
    sync.value.update({ peer: { ...peer, token: "c".repeat(64) } })
    const handle = createGateway({ options, sync: sync.value })
    const response = await handle(fromPeer(manifest, { nonce: "9".repeat(32) }), "192.168.1.20")
    const body = new Uint8Array(await response.arrayBuffer())
    expect(response.status).toBe(401)
    expect(
      verifyResponse(peer.token, "9".repeat(32), 401, body, response.headers.get(SYNC_RESPONSE_SIGNATURE_HEADER)),
    ).toBe(true)
  })

  test("verify a signed round trip over a real socket", async () => {
    const handle = createGateway({ options, sync: gate({ peer }).value })
    const server = Bun.serve({ port: 0, fetch: (request, srv) => handle(request, srv.requestIP(request)?.address) })
    const reply = await signedRequest({
      peer: { url: `http://127.0.0.1:${server.port}`, token: peer.token },
      path: "/flynncode-sync/manifest",
      timeoutMs: 5_000,
    })
    server.stop(true)
    expect(reply?.status).toBe(200)
    expect(reply?.verified).toBe(true)
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
      fromPeer("http://gateway/flynncode-sync/manifest"),
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

describe("hub write forwarding", () => {
  test("non-hub rejects remote apply, hub forwards to upstream", async () => {
    const plain = gate({ peer })
    const blocked = await handleSync({
      request: fromPeer("/flynncode-sync/apply", { method: "POST", body: JSON.stringify({ bundle: {} }) }),
      remoteAddress: "192.168.1.20",
      options,
      gate: plain.value,
    })
    expect(blocked.status).toBe(404)
    await blocked.body?.cancel().catch(() => undefined)

    const hub = gate({ peer, hubMode: true })
    const forwarded = await handleSync({
      request: fromPeer("/flynncode-sync/apply", { method: "POST", body: JSON.stringify({ bundle: {} }) }),
      remoteAddress: "192.168.1.20",
      options,
      gate: hub.value,
    })
    expect(forwarded.status).toBe(200)
    expect(await forwarded.json()).toEqual({ path: "/flynncode-sync/apply" })
    expect(upstreamPaths.at(-1)).toBe("/flynncode-sync/apply")
  })
})
