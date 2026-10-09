import { envAuthHeader, type GatewayOptions } from "./config.ts"
import { streamThrough } from "./proxy.ts"
import type { SyncGate } from "./sync-gate.ts"
import { upstreamUrl } from "./upstream.ts"

// Only these read-only routes reach the local server for a paired peer.
// apply/delete/archive/missing stay loopback-only for the local sync worker.
const FORWARDED = /^\/flynncode-sync\/(manifest|settings|session\/ses[A-Za-z0-9_-]+)$/
const PAIR_MAX_BODY_BYTES = 4096
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
  if (upstream.ok && pathname.startsWith("/flynncode-sync/session/")) gate.countSent()
  return streamThrough(upstream)
}

async function pair(request: Request, remoteAddress: string | undefined, gate: SyncGate) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > PAIR_MAX_BODY_BYTES) return json({ error: "payload too large" }, 413)
  const body: unknown = await request.json().catch(() => undefined)
  if (!isRecord(body) || typeof body.code !== "string" || typeof body.name !== "string")
    return json({ error: "bad request" }, 400)
  const result = gate.pair({ code: body.code, name: body.name, remoteAddress })
  if (result === "invalid") return json({ error: "invalid-code" }, 403)
  if (result === "locked") return json({ error: "locked" }, 429)
  return json(result, 200)
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
