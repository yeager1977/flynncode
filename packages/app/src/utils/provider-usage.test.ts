import { describe, expect, test } from "bun:test"
import { bindingWindow, formatResetTime, orderedWindows, usageEntries } from "./provider-usage"

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

describe("bindingWindow", () => {
  test("picks the reported percent closest to the limit", () => {
    expect(
      bindingWindow([
        { id: "daily", percent: 60 },
        { id: "weekly", percent: 10 },
        { id: "requests", count: 5 },
      ]),
    ).toEqual({ id: "daily", percent: 60 })
  })

  test("is undefined when no window reports a percent", () => {
    expect(bindingWindow([{ id: "requests", count: 5 }])).toBeUndefined()
    expect(bindingWindow([])).toBeUndefined()
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

  test("keeps a session-engaged provider that is neither connected nor reporting", () => {
    const entries = usageEntries({
      connected: [],
      usage: undefined,
      extraIDs: ["opencode"],
    })
    expect(entries.map((entry) => entry.providerID)).toEqual(["opencode"])
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
