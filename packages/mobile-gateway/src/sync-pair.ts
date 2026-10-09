import type { SyncPeer } from "./sync-gate.ts"

export const SYNC_PORT = 4097
const PAIR_TIMEOUT_MS = 5000
const UNPAIR_TIMEOUT_MS = 3000

export type PairResult = { ok: true; peer: SyncPeer } | { ok: false; reason: "unreachable" | "invalid-code" | "failed" }

// Accepts what a user types: `starship.local`, `192.168.1.20`, `host:port`
// or a full http(s) URL.
export function peerBaseUrl(host: string) {
  const trimmed = host.trim().replace(/\/+$/, "")
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[^:]+:\d+$/.test(trimmed)) return `http://${trimmed}`
  if (trimmed.includes(":")) return `http://[${trimmed}]:${SYNC_PORT}`
  return `http://${trimmed}:${SYNC_PORT}`
}

export async function pairWithPeer(input: {
  host: string
  code: string
  name: string
  fetchImpl?: typeof fetch
}): Promise<PairResult> {
  const url = peerBaseUrl(input.host)
  const response = await (input.fetchImpl ?? fetch)(`${url}/flynncode-sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: input.code.trim(), name: input.name }),
    redirect: "error",
    signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response) return { ok: false, reason: "unreachable" }
  if (response.status === 403 || response.status === 429) return { ok: false, reason: "invalid-code" }
  if (!response.ok) return { ok: false, reason: "failed" }
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body) || typeof body.token !== "string" || typeof body.name !== "string")
    return { ok: false, reason: "failed" }
  return { ok: true, peer: { name: body.name, url, token: body.token } }
}

// Best effort: an unreachable peer keeps its record until it notices the 401.
export async function unpairPeer(input: { peer: SyncPeer; fetchImpl?: typeof fetch }) {
  await (input.fetchImpl ?? fetch)(`${input.peer.url}/flynncode-sync/unpair`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.peer.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(UNPAIR_TIMEOUT_MS),
  }).catch(() => undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
