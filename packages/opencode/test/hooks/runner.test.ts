import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"

test("hooks expose session lifecycle keys", () => {
  const keys: Array<keyof Hooks> = ["session.start", "session.end", "tool.permission"]
  expect(keys.length).toBe(3)
})
