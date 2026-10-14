// Plain TypeScript on purpose: this is bundled into the desktop renderer, so no node builtins or Effect services.

// Shared by message and body. `\w*UsageLimitError` covers the Free/Go/Black variants.
const LIMIT_PATTERN =
  /rate[\s_-]?limit|usage[\s_-]?limit|\w*UsageLimitError|too many requests|insufficient[\s_]quota|quota exceeded|resource[\s_]exhausted/i

/**
 * Classifies a recorded provider error as a usage/rate limit (as opposed to a transient
 * overload). `resetAt` is an epoch-ms timestamp derived from the retry-after headers.
 * `x-ratelimit-reset` is intentionally ignored: providers disagree on whether it is an
 * epoch, a duration, or a duration string.
 */
export function usageLimit(error: { name: string; data?: unknown } | undefined, now = Date.now()) {
  if (error?.name !== "APIError") return undefined
  const data = record(error.data)
  if (!data) return undefined

  const message = typeof data.message === "string" ? data.message : undefined
  const body = typeof data.responseBody === "string" ? data.responseBody : undefined
  // Status wins: 429 is always a limit, 5xx is always a server failure, otherwise fall back to text heuristics.
  const status = typeof data.statusCode === "number" ? data.statusCode : undefined
  if (status !== undefined && status >= 500) return undefined
  const limited = status === 429 || LIMIT_PATTERN.test(message ?? "") || LIMIT_PATTERN.test(body ?? "")
  if (!limited) return undefined

  const resetAt = reset(record(data.responseHeaders), now)
  return { message: message || error.name, ...(resetAt === undefined ? {} : { resetAt }) }
}

function record(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function reset(headers: Record<string, unknown> | undefined, now: number) {
  if (!headers) return undefined
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))

  const ms = Number.parseFloat(String(lower["retry-after-ms"] ?? ""))
  if (ms >= 0) return now + ms

  const retryAfter = String(lower["retry-after"] ?? "")
  if (!retryAfter) return undefined
  const seconds = Number.parseFloat(retryAfter)
  if (!Number.isNaN(seconds)) return seconds >= 0 ? now + Math.ceil(seconds * 1000) : undefined
  const date = Date.parse(retryAfter)
  return Number.isNaN(date) || date <= now ? undefined : date
}
