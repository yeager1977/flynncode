import { envAuthHeader, type GatewayOptions } from "./config.ts"
import type { SyncGate } from "./sync-gate.ts"
import { SYNC_RESPONSE_SIGNATURE_HEADER } from "./sync-sign.ts"
import { upstreamUrl } from "./upstream.ts"

// Only these read-only routes reach the local server for a paired peer.
// apply/delete/archive/missing stay loopback-only for the local sync worker.
const FORWARDED = /^\/flynncode-sync\/(manifest|settings|session\/ses[A-Za-z0-9_-]+)$/
const PAIR_MAX_BODY_BYTES = 4096
// Signed sync requests carry no meaningful body (unpair is an empty POST).
const SIGNED_MAX_BODY_BYTES = 4096
const MAX_ADVERTISED = 16
const HOST_NAME = /^[A-Za-z0-9.-]{1,253}$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const UPSTREAM_TIMEOUT_MS = 60_000

export async function handleSync(input: {
  request: Request
  remoteAddress: string | undefined
  options: GatewayOptions
  gate: SyncGate | undefined
}): Promise<Response> {
  const gate = input.gate
  if (!gate) return json({ error: "not found" }, 404)
  const url = new URL(input.request.url, "http://localhost")
  if (url.pathname === "/flynncode-sync/pair") return pair(input.request, input.remoteAddress, gate)
  // A request signed with the pairing token is the only credential here; the
  // token itself never travels, and the phone password never opens sync routes.
  const method = input.request.method
  const body =
    method === "GET" || method === "HEAD" || !input.request.body
      ? new Uint8Array()
      : await readCapped(input.request.body.getReader(), SIGNED_MAX_BODY_BYTES)
  const verified =
    body && gate.verify({ method, target: url.pathname + url.search, headers: input.request.headers, body })
  // Unsigned: the peer treats it as no answer, since anyone on the path could send it.
  if (!verified) return json({ error: "unauthorized" }, 401)
  // Signed refusals the peer can act on: "clock" carries this machine's time
  // so it can report the skew; "revoked" means pair again.
  if (!verified.ok) return signed(verified.sign, json({ error: verified.reason, now: Date.now() }, 401))
  verified.seen(input.remoteAddress)
  return signed(verified.sign, await route(input, url.pathname))
}

// Every answer to a request signed with the token is signed over the request
// nonce, its status and its body, so the peer can tell it was not altered.
async function signed(sign: (status: number, body: Uint8Array) => string, response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const headers = new Headers({ "content-type": response.headers.get("content-type") ?? "application/json" })
  headers.set(SYNC_RESPONSE_SIGNATURE_HEADER, sign(response.status, bytes))
  return new Response(bytes, { status: response.status, headers })
}

async function route(
  input: { request: Request; options: GatewayOptions; gate: SyncGate | undefined },
  pathname: string,
): Promise<Response> {
  const gate = input.gate
  if (!gate) return json({ error: "not found" }, 404)
  if (pathname === "/flynncode-sync/unpair") {
    if (input.request.method !== "POST") return json({ error: "method not allowed" }, 405)
    gate.revoke()
    return json({ ok: true }, 200)
  }
  if (input.request.method !== "GET") return json({ error: "method not allowed" }, 405)
  if (gate.paused()) return json({ error: "paused" }, 503)
  if (pathname === "/flynncode-sync/prefs") return json({ prefs: gate.prefs() ?? null }, 200)
  if (!FORWARDED.test(pathname)) return json({ error: "not found" }, 404)
  const upstream = await fetch(upstreamUrl(input.options.upstream, input.request.url), {
    headers: { authorization: envAuthHeader(input.options) },
    redirect: "error",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!upstream) return json({ error: "upstream unavailable" }, 502)
  // The local server refusing our own credential is a fault on this machine;
  // passed through, the peer would wrongly ask its user to pair again.
  if (upstream.status === 401) {
    await upstream.body?.cancel().catch(() => undefined)
    return json({ error: "upstream refused the gateway" }, 502)
  }
  if (upstream.ok && pathname.startsWith("/flynncode-sync/session/")) gate.countSent()
  return upstream
}

async function pair(request: Request, remoteAddress: string | undefined, gate: SyncGate) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
  // Nothing is read while no code is waiting, so an idle gateway never buffers a body.
  if (!gate.pairingActive()) return json({ error: "invalid-code" }, 403)
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > PAIR_MAX_BODY_BYTES) return json({ error: "payload too large" }, 413)
  // content-length is only a hint (chunked bodies have none): the read itself stops past the cap.
  const bytes = request.body ? await readCapped(request.body.getReader(), PAIR_MAX_BODY_BYTES) : new Uint8Array()
  if (bytes === undefined) return json({ error: "payload too large" }, 413)
  const body: unknown = await new Response(Buffer.from(bytes).toString("utf8")).json().catch(() => undefined)
  if (!isRecord(body) || typeof body.code !== "string" || typeof body.name !== "string")
    return json({ error: "bad request" }, 400)
  const result = gate.pair({ code: body.code, name: body.name, remoteAddress, advertised: advertised(body) })
  if (result === "invalid") return json({ error: "invalid-code" }, 403)
  if (result === "locked") return json({ error: "locked" }, 429)
  if (result === "unaddressable") return json({ error: "no reachable address" }, 400)
  return json(result, 200)
}

// Resolves to the body bytes, or undefined once they grow past `limit` bytes
// (the rest is never read) or the stream fails.
async function readCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
  chunks: Uint8Array[] = [],
  size = 0,
): Promise<Uint8Array | undefined> {
  const next = await reader.read().catch(() => undefined)
  if (!next) return undefined
  if (next.done) return new Uint8Array(Buffer.concat(chunks))
  if (size + next.value.byteLength > limit) {
    await reader.cancel().catch(() => undefined)
    return undefined
  }
  return readCapped(reader, limit, [...chunks, next.value], size + next.value.byteLength)
}

// Only well-formed host names and IPv4 addresses are kept from the caller's claim.
function advertised(body: Record<string, unknown>) {
  const host = typeof body.host === "string" && HOST_NAME.test(body.host) ? body.host : undefined
  const addresses = Array.isArray(body.addresses)
    ? body.addresses
        .filter((item): item is string => typeof item === "string" && IPV4.test(item))
        .slice(0, MAX_ADVERTISED)
    : []
  return { host, addresses }
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
