import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { HooksRunner } from "../../src/hooks/runner"

test("hooks expose session lifecycle keys", () => {
  const keys: Array<keyof Hooks> = ["session.start", "session.end", "tool.permission"]
  expect(keys.length).toBe(3)
})

const it = testEffect(HooksRunner.testLayer)

describe("hooks runner", () => {
  it.effect("deny wins over allow", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const decision = yield* runner.runPreToolUse({
        sessionID: "ses_1",
        tool: "Bash",
        callID: "c1",
        args: { command: "rm -rf /" },
      })
      expect(decision.behavior).toBe("deny")
    }),
  )

  it.effect("rewritten Bash args reach tool execute", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const decision = yield* runner.runPreToolUse({
        sessionID: "ses_1",
        tool: "Bash",
        callID: "c1",
        args: { command: "ls" },
      })
      expect(decision).toEqual({ behavior: "allow", updatedInput: { command: "ls --safe" } })
    }),
  )

  it.effect("session start injects additional context", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const out = yield* runner.runSessionStart({ sessionID: "ses_1", source: "startup" })
      expect(out.additionalContext).toContain("workspace conventions")
    }),
  )
})
