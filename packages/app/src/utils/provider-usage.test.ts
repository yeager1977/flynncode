import { describe, expect, test } from "bun:test"
import { formatResetTime, orderedWindows, usageEntries } from "./provider-usage"

describe("orderedWindows", () => {
  test("renders percent windows before count-only windows", () => {
    const windows = [
      { id: "requests", count: 100 },
      { id: "daily", percent: 60 },
      { id: "weekly", percent: 10 },
    ]
    expect(orderedWindows(windows).map((window) => window.id)).toEqual(["weekly", "daily", "requests"])
  })

  test("orders known percent window labels before unknown ids", () => {
    const windows = [
      { id: "custom", percent: 1 },
      { id: "weekly", percent: 20 },
      { id: "session", percent: 30 },
    ]
    expect(orderedWindows(windows).map((window) => window.id)).toEqual(["session", "weekly", "custom"])
  })
})

describe("usageEntries", () => {
  test("merges connected providers with usage reporters, router excluded, name sorted", () => {
    const entries = usageEntries({
      connected: [
        { id: "model-router", name: "Model Router" },
        { id: "ollama-gpu", name: "Ollama" },
      ],
      usage: {
        "ollama-cloud": { windows: [{ id: "daily", percent: 10 }] },
        anthropic: { windows: [{ id: "weekly", percent: 40 }] },
      },
    })
    expect(entries.map((entry) => entry.providerID)).toEqual(["anthropic", "ollama-gpu", "ollama-cloud"])
    expect(entries[0].windows).toEqual([{ id: "weekly", percent: 40 }])
    expect(entries[2].windows).toEqual([{ id: "daily", percent: 10 }])
  })

  test("a connected provider that reports usage carries its windows", () => {
    const entries = usageEntries({
      connected: [
        { id: "ollama-cloud", name: "Ollama Cloud" },
        { id: "openai", name: "OpenAI" },
      ],
      usage: {
        "ollama-cloud": { windows: [{ id: "daily", count: 1423 }] },
        anthropic: { windows: [{ id: "weekly", percent: 40 }] },
      },
    })
    expect(entries.map((entry) => entry.providerID)).toEqual(["anthropic", "ollama-cloud", "openai"])
    expect(entries.find((entry) => entry.providerID === "ollama-cloud")?.windows).toEqual([
      { id: "daily", count: 1423 },
    ])
    // Connected but not reporting: still listed, without windows.
    expect(entries.find((entry) => entry.providerID === "openai")?.windows).toEqual([])
  })

  test("lists connected providers before any usage has loaded", () => {
    const entries = usageEntries({ connected: [{ id: "openai", name: "OpenAI" }], usage: undefined })
    expect(entries).toEqual([{ providerID: "openai", name: "OpenAI", windows: [] }])
  })
})

describe("formatResetTime", () => {
  test("renders the time of day for a reset later today", () => {
    const now = new Date(2026, 9, 18, 9, 0).getTime()
    const resetAt = new Date(2026, 9, 18, 15, 4).getTime()
    expect(formatResetTime(resetAt, now)).toMatch(/15:04|3:04/)
  })

  test("renders date and time once the reset is beyond today", () => {
    const now = new Date(2026, 9, 18, 9, 0).getTime()
    const resetAt = new Date(2026, 9, 19, 15, 4).getTime()
    expect(formatResetTime(resetAt, now)).toMatch(/10\/19\/26|10\/19\/2026|19[\./]10/)
  })
})
