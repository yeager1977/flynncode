const STRIPPED = ["content-encoding", "content-length", "transfer-encoding"]

export function proxyResponseHeaders(headers: Headers) {
  const result = new Headers(headers)
  for (const key of STRIPPED) result.delete(key)
  return result
}

export function streamThrough(upstream: Response) {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: proxyResponseHeaders(upstream.headers),
  })
}