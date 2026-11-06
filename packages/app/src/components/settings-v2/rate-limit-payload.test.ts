import { describe, expect, test } from "bun:test"
import { rateLimitFromConfig, rateLimitToConfig, retryUnderFromInput } from "./rate-limit-payload"

describe("rate limit payload", () => {
  test("falls back to the server defaults when the block is unset", () => {
    expect(rateLimitFromConfig(undefined)).toEqual({ onLimit: "stop", retryUnder: 0, fallback: [] })
    expect(rateLimitFromConfig({})).toEqual({ onLimit: "stop", retryUnder: 0, fallback: [] })
    expect(rateLimitFromConfig({ rate_limit: {} })).toEqual({ onLimit: "stop", retryUnder: 0, fallback: [] })
  })

  test("reads on_limit and retry_under", () => {
    expect(rateLimitFromConfig({ rate_limit: { on_limit: "retry", retry_under: 30 } })).toEqual({
      onLimit: "retry",
      retryUnder: 30,
      fallback: [],
    })
    expect(rateLimitFromConfig({ rate_limit: { retry_under: 45 } })).toEqual({ onLimit: "stop", retryUnder: 45, fallback: [] })
  })

  test("always writes the full block", () => {
    expect(rateLimitToConfig({ onLimit: "retry", retryUnder: 0, fallback: [] })).toEqual({
      on_limit: "retry",
      retry_under: 0,
      fallback: [],
    })
    expect(rateLimitToConfig({ onLimit: "stop", retryUnder: 90, fallback: ["anthropic/claude-opus-5-5"] })).toEqual({
      on_limit: "stop",
      retry_under: 90,
      fallback: ["anthropic/claude-opus-5-5"],
    })
  })

  test("round-trips through config", () => {
    const value = { onLimit: "stop" as const, retryUnder: 12, fallback: ["openai/gpt-6-luna"] }
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
