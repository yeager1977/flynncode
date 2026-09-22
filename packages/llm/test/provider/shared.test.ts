import { describe, expect, test } from "bun:test"
import { ProviderShared } from "../../src/protocols/shared"

describe("ProviderShared.rejectsForcedToolChoice", () => {
  test.each([
    "claude-opus-5-5",
    "claude-opus-5.5",
    "claude-5-5-opus",
    "anthropic.claude-opus-5-5",
    "claude-fable-5-1",
    "claude-fable-5.2",
    "claude-sonnet-5-5",
  ])("rejects forced tool choice for %s", (id) => {
    expect(ProviderShared.rejectsForcedToolChoice(id)).toBe(true)
  })

  test.each([
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-3-5-sonnet-20240620",
    "claude-fable-5",
    "claude-mythos-5-1",
    "gpt-5-mini",
    "gemini-2.0-flash",
  ])("allows forced tool choice for %s", (id) => {
    expect(ProviderShared.rejectsForcedToolChoice(id)).toBe(false)
  })
})