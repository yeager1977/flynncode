import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigMemoryV1 } from "../src/v1/config/memory"

describe("memory config", () => {
  test("defaults to disabled when absent", () => {
    const decoded = Schema.decodeUnknownSync(ConfigMemoryV1.Info)({})
    expect(decoded.enabled ?? false).toBe(false)
  })
  test("accepts enabled plus tunables", () => {
    const decoded = Schema.decodeUnknownSync(ConfigMemoryV1.Info)({
      enabled: true,
      min_turns: 4,
      max_files: 50,
      max_chars_per_file: 4000,
    })
    expect(decoded.enabled).toBe(true)
    expect(decoded.min_turns).toBe(4)
  })
  test("rejects negative min_turns", () => {
    expect(() => Schema.decodeUnknownSync(ConfigMemoryV1.Info)({ min_turns: -1 })).toThrow()
  })
})
