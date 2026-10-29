import { describe, expect, test } from "bun:test"
import { type Notification, trimNotifications } from "./notification"

const now = Date.UTC(2026, 9, 28)
const day = 24 * 60 * 60 * 1000

const error = (time: number): Notification => ({
  type: "error",
  time,
  viewed: false,
  session: "ses_1",
  directory: "/repo",
  error: {
    name: "APIError",
    data: { message: "rate limited", statusCode: 429, isRetryable: true, responseBody: "x".repeat(20_000) },
  } as unknown as Extract<Notification, { type: "error" }>["error"],
})

describe("trimNotifications", () => {
  test("keeps only the error name and a bounded message", () => {
    const [item] = trimNotifications([error(now)], now)
    expect(item).toEqual({
      type: "error",
      time: now,
      viewed: false,
      session: "ses_1",
      directory: "/repo",
      error: { name: "APIError", data: { message: "rate limited" } },
    })
    expect(JSON.stringify(trimNotifications([error(now)], now)).length).toBeLessThan(300)
  })

  test("drops expired entries and keeps the newest within the cap", () => {
    const list = [
      error(now - 31 * day),
      ...Array.from(
        { length: 505 },
        (_, index): Notification => ({ type: "turn-complete", time: now - 505 + index, viewed: true }),
      ),
    ]
    const trimmed = trimNotifications(list, now)
    expect(trimmed).toHaveLength(500)
    expect(trimmed[0]?.time).toBe(now - 500)
    expect(trimmed.at(-1)?.time).toBe(now - 1)
  })

  test("keeps already trimmed entries by identity so the index still matches them", () => {
    const once = trimNotifications([error(now)], now)
    expect(trimNotifications(once, now)[0]).toBe(once[0])
  })

  test("returns turn-complete entries unchanged", () => {
    const item: Notification = { type: "turn-complete", time: now, viewed: true, session: "ses_1" }
    expect(trimNotifications([item], now)[0]).toBe(item)
  })
})
