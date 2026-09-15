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
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    headers[key] = value
  }
  headers.authorization = input.authorization
  return headers
}

async function probe(input: { base: string; authorization: string }) {
  const url = upstreamUrl(input.base, "http://gateway/api/session?limit=1")
  try {
    const response = await fetch(url, {
      headers: { authorization: input.authorization },
      signal: AbortSignal.timeout(5000),
    })
    return response.status !== 401
  } catch {
    return false
  }
}

export const Upstream = { probe }