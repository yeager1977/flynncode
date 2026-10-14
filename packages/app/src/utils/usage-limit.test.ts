import { describe, expect, test } from "bun:test"
import type { Message } from "@flynncode/sdk/v2"
import { endedOnUsageLimit, usageLimitResetTime } from "./usage-limit"

const assistant = (id: string, error?: unknown) =>
  ({
    id,
    sessionID: "ses_1",
    role: "assistant",
    parentID: "msg_user",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1 },
    error,
  }) as Message

const user = { id: "msg_user", sessionID: "ses_1", role: "user", time: { created: 0 } } as Message
const limit = { name: "APIError", data: { message: "Rate limit exceeded", statusCode: 429, isRetryable: true } }

describe("endedOnUsageLimit", () => {
  test("detects a usage limit on the newest assistant turn", () => {
    expect(endedOnUsageLimit([user, assistant("a1", limit)])).toBe(true)
  })

  test("ignores an older limit once a later turn succeeded", () => {
    expect(endedOnUsageLimit([user, assistant("a1", limit), user, assistant("a2")])).toBe(false)
  })

  test("ignores other errors and missing history", () => {
    const overloaded = { name: "APIError", data: { message: "Overloaded", statusCode: 503, isRetryable: true } }
    expect(endedOnUsageLimit([user, assistant("a1", overloaded)])).toBe(false)
    expect(endedOnUsageLimit([user])).toBe(false)
    expect(endedOnUsageLimit(undefined)).toBe(false)
  })
})

describe("usageLimitResetTime", () => {
  const now = new Date(2026, 9, 14, 9, 0).getTime()

  test("shows only the time for a reset later today", () => {
    const text = usageLimitResetTime(new Date(2026, 9, 14, 15, 30).getTime(), "en-US", now)
    expect(text).toContain("3:30")
    expect(text).not.toContain("Oct")
  })

  test("includes the date for a reset on another day", () => {
    const text = usageLimitResetTime(new Date(2026, 9, 15, 15, 30).getTime(), "en-US", now)
    expect(text).toContain("Oct 15")
    expect(text).toContain("3:30")
  })
})
