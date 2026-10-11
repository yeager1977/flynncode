import { describe, expect, test } from "bun:test"
import { memoryFromConfig, memoryToConfig, minTurnsFromInput } from "./memory-payload"

describe("memory payload", () => {
  test("falls back to the server decode defaults when the block is unset", () => {
    expect(memoryFromConfig(undefined)).toEqual({ enabled: false, minTurns: 4 })
    expect(memoryFromConfig({ memory: {} })).toEqual({ enabled: false, minTurns: 4 })
  })

  test("reads enabled and min_turns, ignoring keys the card does not edit", () => {
    expect(memoryFromConfig({ memory: { enabled: true, min_turns: 2, max_files: 7 } })).toEqual({
      enabled: true,
      minTurns: 2,
    })
  })

  test("builds the full memory block, preserving sibling keys", () => {
    expect(memoryToConfig({ max_files: 12, max_chars_per_file: 500 }, { enabled: true })).toEqual({
      enabled: true,
      max_files: 12,
      max_chars_per_file: 500,
    })
    expect(memoryToConfig({ enabled: false, max_files: 12 }, { min_turns: 6 })).toEqual({
      enabled: false,
      min_turns: 6,
      max_files: 12,
    })
  })

  test("parses non-negative integers only", () => {
    expect(minTurnsFromInput("3")).toBe(3)
    expect(minTurnsFromInput(" 0 ")).toBe(0)
    expect(minTurnsFromInput("-1")).toBeUndefined()
    expect(minTurnsFromInput("abc")).toBeUndefined()
    expect(minTurnsFromInput("")).toBeUndefined()
  })
})
