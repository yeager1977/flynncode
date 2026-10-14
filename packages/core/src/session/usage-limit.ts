// Plain TypeScript on purpose: this is bundled into the desktop renderer, so no node builtins or Effect services.

const MESSAGE_PATTERN = /rate[\s_-]?limit|usage limit|too many requests|insufficient[\s_]quota|quota exceeded/i
const BODY_PATTERN = /insufficient_quota|FreeUsageLimitError|resource_exhausted/i

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
  const limited =
    data.statusCode === 429 || (message && MESSAGE_PATTERN.test(message)) || (body && BODY_PATTERN.test(body))
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
  if (!Number.isNaN(ms)) return now + ms

  const retryAfter = lower["retry-after"]
  if (typeof retryAfter !== "string" || !retryAfter) return undefined
  const seconds = Number.parseFloat(retryAfter)
  if (!Number.isNaN(seconds)) return now + Math.ceil(seconds * 1000)
  const date = Date.parse(retryAfter)
  return Number.isNaN(date) || date <= now ? undefined : date
}
