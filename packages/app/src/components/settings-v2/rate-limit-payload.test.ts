import { describe, expect, test } from "bun:test"
import { rateLimitFromConfig, rateLimitToConfig, retryUnderFromInput } from "./rate-limit-payload"

describe("rate limit payload", () => {
  test("falls back to the server defaults when the block is unset", () => {
    expect(rateLimitFromConfig(undefined)).toEqual({ onLimit: "stop", retryUnder: 0 })
    expect(rateLimitFromConfig({})).toEqual({ onLimit: "stop", retryUnder: 0 })
    expect(rateLimitFromConfig({ rate_limit: {} })).toEqual({ onLimit: "stop", retryUnder: 0 })
  })

  test("reads on_limit and retry_under", () => {
    expect(rateLimitFromConfig({ rate_limit: { on_limit: "retry", retry_under: 30 } })).toEqual({
      onLimit: "retry",
      retryUnder: 30,
    })
    expect(rateLimitFromConfig({ rate_limit: { retry_under: 45 } })).toEqual({ onLimit: "stop", retryUnder: 45 })
  })

  test("always writes the full block", () => {
    expect(rateLimitToConfig({ onLimit: "retry", retryUnder: 0 })).toEqual({ on_limit: "retry", retry_under: 0 })
    expect(rateLimitToConfig({ onLimit: "stop", retryUnder: 90 })).toEqual({ on_limit: "stop", retry_under: 90 })
  })

  test("round-trips through config", () => {
    const value = { onLimit: "stop" as const, retryUnder: 12 }
    expect(rateLimitFromConfig({ rate_limit: rateLimitToConfig(value) })).toEqual(value)
  })

  test("parses non-negative whole seconds only", () => {
    expect(retryUnderFromInput("0")).toBe(0)
    expect(retryUnderFromInput(" 60 ")).toBe(60)
    expect(retryUnderFromInput("")).toBeUndefined()
    expect(retryUnderFromInput("-5")).toBeUndefined()
    expect(retryUnderFromInput("1.5")).toBeUndefined()
    expect(retryUnderFromInput("abc")).toBeUndefined()
  })
})
