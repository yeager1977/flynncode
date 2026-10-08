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

const mergeIt = testEffect(
  HooksRunner.testLayerWithHooks([
    {
      "tool.permission": async (_input, output) => {
        output.decision = "allow"
        output.updatedInput = { command: "ls", extra: "one" }
      },
    },
    {
      "tool.permission": async (_input, output) => {
        output.decision = "allow"
        output.updatedInput = { verbose: true }
      },
    },
  ]),
)

describe("hooks runner decision aggregation", () => {
  mergeIt.effect("allow rewrites merge across hooks", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const decision = yield* runner.runPermissionRequest({
        sessionID: "ses_1",
        tool: "Bash",
        callID: "c1",
        args: { command: "ls" },
      })
      expect(decision).toEqual({
        behavior: "allow",
        updatedInput: { command: "ls", extra: "one", verbose: true },
      })
    }),
  )
})

const denyMessageIt = testEffect(
  HooksRunner.testLayerWithHooks([
    {
      "tool.permission": async (_input, output) => {
        output.decision = "allow"
        output.updatedInput = { command: "x" }
      },
    },
    {
      "tool.permission": async (_input, output) => {
        output.decision = "deny"
        output.message = "blocked for safety"
      },
    },
  ]),
)

describe("hooks runner deny propagation", () => {
  denyMessageIt.effect("first deny short-circuits with its message", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const decision = yield* runner.runPermissionRequest({
        sessionID: "ses_1",
        tool: "Bash",
        callID: "c1",
        args: { command: "x" },
      })
      expect(decision).toEqual({ behavior: "deny", message: "blocked for safety" })
    }),
  )
})
