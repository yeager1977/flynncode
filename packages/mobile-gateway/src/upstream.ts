const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
])

export function upstreamUrl(base: string, incomingUrl: string) {
  const incoming = new URL(incomingUrl)
  incoming.searchParams.delete("auth_token")
  const target = new URL(base)
  const prefix = target.pathname.replace(/\/+$/, "")
  target.pathname = `${prefix}${incoming.pathname}`
  target.search = incoming.search
  target.hash = ""
  return target
}

export function upstreamHeaders(input: {
  base: string
  authorization: string
  incoming?: Record<string, string>
}) {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.incoming ?? {})) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower === "authorization") continue
    headers[key] = value
  }
  headers.authorization = input.authorization
  return headers
}

type ProbeResult = { ok: true } | { ok: false; reason: "unauthorized" | "unreachable" }

async function probe(input: { base: string; authorization: string }): Promise<ProbeResult> {
  const url = upstreamUrl(input.base, "http://gateway/api/session?limit=1")
  try {
    const response = await fetch(url, {
      headers: { authorization: input.authorization },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    })
    if (response.ok) return { ok: true }
    if (response.status === 401) return { ok: false, reason: "unauthorized" }
    return { ok: false, reason: "unreachable" }
  } catch {
    return { ok: false, reason: "unreachable" }
  }
}

export const Upstream = { probe }