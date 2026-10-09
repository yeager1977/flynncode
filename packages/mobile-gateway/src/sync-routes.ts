import { envAuthHeader, type GatewayOptions } from "./config.ts"
import { streamThrough } from "./proxy.ts"
import type { SyncGate } from "./sync-gate.ts"
import { upstreamUrl } from "./upstream.ts"

// Only these read-only routes reach the local server for a paired peer.
// apply/delete/archive/missing stay loopback-only for the local sync worker.
const FORWARDED = /^\/flynncode-sync\/(manifest|settings|session\/ses[A-Za-z0-9_-]+)$/
const PAIR_MAX_BODY_BYTES = 4096
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
  const pathname = new URL(input.request.url, "http://localhost").pathname
  if (pathname === "/flynncode-sync/pair") return pair(input.request, input.remoteAddress, gate)
  // The pairing token is the only credential here; the phone password never
  // opens sync routes.
  if (!gate.authorized(input.request.headers.get("authorization"))) return json({ error: "unauthorized" }, 401)
  gate.seen(input.remoteAddress)
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
  return streamThrough(upstream)
}

async function pair(request: Request, remoteAddress: string | undefined, gate: SyncGate) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
  // Nothing is read while no code is waiting, so an idle gateway never buffers a body.
  if (!gate.pairingActive()) return json({ error: "invalid-code" }, 403)
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > PAIR_MAX_BODY_BYTES) return json({ error: "payload too large" }, 413)
  // content-length is only a hint (chunked bodies have none): the read itself stops past the cap.
  const text = request.body ? await readCapped(request.body.getReader(), PAIR_MAX_BODY_BYTES) : ""
  if (text === undefined) return json({ error: "payload too large" }, 413)
  const body: unknown = await new Response(text).json().catch(() => undefined)
  if (!isRecord(body) || typeof body.code !== "string" || typeof body.name !== "string")
    return json({ error: "bad request" }, 400)
  const result = gate.pair({ code: body.code, name: body.name, remoteAddress, advertised: advertised(body) })
  if (result === "invalid") return json({ error: "invalid-code" }, 403)
  if (result === "locked") return json({ error: "locked" }, 429)
  if (result === "unaddressable") return json({ error: "no reachable address" }, 400)
  return json(result, 200)
}

// Resolves to the body text, or undefined once it grows past `limit` bytes
// (the rest is never read) or the stream fails.
async function readCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
  chunks: Uint8Array[] = [],
  size = 0,
): Promise<string | undefined> {
  const next = await reader.read().catch(() => undefined)
  if (!next) return undefined
  if (next.done) return Buffer.concat(chunks).toString("utf8")
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
    ? body.addresses.filter((item): item is string => typeof item === "string" && IPV4.test(item)).slice(0, MAX_ADVERTISED)
    : []
  return { host, addresses }
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
