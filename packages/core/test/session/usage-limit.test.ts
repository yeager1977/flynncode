import { describe, expect, test } from "bun:test"
import { usageLimit } from "@flynncode/core/session/usage-limit"

const now = Date.parse("2026-10-14T12:00:00Z")

function apiError(data: Record<string, unknown>) {
  return { name: "APIError", data: { message: "Provider error", isRetryable: true, ...data } }
}

describe("usageLimit", () => {
  test("classifies a 429 status as a usage limit", () => {
    expect(usageLimit(apiError({ statusCode: 429, message: "Too fast" }), now)).toEqual({ message: "Too fast" })
  })

  test("classifies a rate limit message without a status", () => {
    expect(usageLimit(apiError({ message: "Rate limit exceeded" }), now)).toEqual({ message: "Rate limit exceeded" })
  })

  test.each(["insufficient_quota", "FreeUsageLimitError", "resource_exhausted"])("classifies response body %s", (code) => {
    expect(usageLimit(apiError({ statusCode: 400, message: "Bad", responseBody: `{"error":{"code":"${code}"}}` }), now)).toEqual({
      message: "Bad",
    })
  })

  test("ignores overloaded 503 errors", () => {
    expect(usageLimit(apiError({ statusCode: 503, message: "Service overloaded" }), now)).toBeUndefined()
  })

  test("ignores non-APIError errors", () => {
    expect(usageLimit({ name: "ContextOverflowError", data: { message: "Rate limit exceeded" } }, now)).toBeUndefined()
    expect(usageLimit(undefined, now)).toBeUndefined()
  })

  test("tolerates malformed data", () => {
    expect(usageLimit({ name: "APIError" }, now)).toBeUndefined()
    expect(usageLimit({ name: "APIError", data: "nope" }, now)).toBeUndefined()
    expect(usageLimit({ name: "APIError", data: { statusCode: 429, responseHeaders: "x" } }, now)).toEqual({
      message: "APIError",
    })
  })

  test("falls back to the error name when there is no message", () => {
    expect(usageLimit({ name: "APIError", data: { statusCode: 429 } }, now)).toEqual({ message: "APIError" })
  })

  test("reads retry-after seconds", () => {
    expect(usageLimit(apiError({ statusCode: 429, responseHeaders: { "retry-after": "120" } }), now)?.resetAt).toBe(
      now + 120_000,
    )
  })

  test("reads retry-after-ms", () => {
    expect(usageLimit(apiError({ statusCode: 429, responseHeaders: { "retry-after-ms": "5000" } }), now)?.resetAt).toBe(
      now + 5000,
    )
  })

  test("reads retry-after HTTP dates", () => {
    const at = now + 90_000
    expect(
      usageLimit(apiError({ statusCode: 429, responseHeaders: { "retry-after": new Date(at).toUTCString() } }), now)?.resetAt,
    ).toBe(at)
  })

  test("reads headers case-insensitively", () => {
    expect(usageLimit(apiError({ statusCode: 429, responseHeaders: { "Retry-After": "10" } }), now)?.resetAt).toBe(
      now + 10_000,
    )
  })

  test("leaves resetAt undefined without usable headers", () => {
    expect(usageLimit(apiError({ statusCode: 429 }), now)?.resetAt).toBeUndefined()
    expect(usageLimit(apiError({ statusCode: 429, responseHeaders: {} }), now)?.resetAt).toBeUndefined()
    expect(usageLimit(apiError({ statusCode: 429, responseHeaders: { "retry-after": "soon" } }), now)?.resetAt).toBeUndefined()
  })
})
