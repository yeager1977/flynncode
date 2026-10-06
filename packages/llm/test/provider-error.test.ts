import { describe, expect, test } from "bun:test"
import { classifyInvalidRequest, isContextOverflow, isRepetitiveContent } from "../src/provider-error"
import { ProviderShared } from "../src/protocols/shared"

describe("provider error classification", () => {
  test("classifies provider token limit messages as context overflow", () => {
    const messages = [
      "tokens in request more than max tokens allowed",
      '{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
      "Requested token count exceeds the model's maximum context length of 131072 tokens.",
      "Input length (265330) exceeds model's maximum context length (262144).",
      "Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
      "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
      "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
      "Too many tokens",
      "Token limit exceeded",
    ]

    expect(messages.every(isContextOverflow)).toBe(true)
  })

  test("does not classify rate limits as context overflow", () => {
    const messages = [
      "Throttling error: Too many tokens, please wait before trying again.",
      "Rate limit exceeded, please retry after 30 seconds.",
      "Too many requests. Please slow down.",
    ]

    expect(messages.some(isContextOverflow)).toBe(false)
  })
})

describe("tool call id folding", () => {
  test("short ids pass through untouched", () => {
    expect(ProviderShared.toolCallIdForWire("call_abc123")).toBe("call_abc123")
    expect(ProviderShared.toolCallIdForWire("prt_" + "a".repeat(26))).toBe("prt_" + "a".repeat(26))
  })

  test("ids over 64 chars fold deterministically to a stable wire id", () => {
    const long = `prt_import_${"a".repeat(32)}_${"9".repeat(21)}`
    expect(long.length).toBeGreaterThan(64)
    const first = ProviderShared.toolCallIdForWire(long)
    const second = ProviderShared.toolCallIdForWire(long)
    expect(first).toBe(second)
    expect(first.startsWith("ocl-")).toBe(true)
    expect(first.length).toBeLessThanOrEqual(64)
    // different long ids fold to different wire ids
    expect(ProviderShared.toolCallIdForWire(long + "x")).not.toBe(first)
  })

  test("64-char ids and under stay untouched, 65 folds", () => {
    expect(ProviderShared.toolCallIdForWire("x".repeat(64))).toBe("x".repeat(64))
    expect(ProviderShared.toolCallIdForWire("x".repeat(65))).not.toBe("x".repeat(65))
  })
})

describe("invalid request classification", () => {
  test("the openai call_id length validation reclassifies as compact-worthy", () => {
    const message = "Invalid request: input[3485].call_id The length of the value must be `<= 64`."
    expect(isRepetitiveContent(message)).toBe(true)
    expect(classifyInvalidRequest(message)).toBe("repetitive-content")
  })

  test("context overflow still classifies first", () => {
    const message = "This model's maximum context length is 200000 tokens"
    expect(isContextOverflow(message)).toBe(true)
    expect(classifyInvalidRequest(message)).toBe("context-overflow")
  })

  test("unrelated 400s stay unclassified", () => {
    expect(classifyInvalidRequest("Invalid request: model does not exist")).toBeUndefined()
  })
})