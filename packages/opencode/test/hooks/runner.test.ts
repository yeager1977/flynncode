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

const fileDenyIt = testEffect(
  HooksRunner.testLayerWithHooks([], {
    runDecision: (): Effect.Effect<HooksRunner.PreToolUseDecision, never, never> =>
      Effect.succeed({ behavior: "deny", message: "file hook says no" }),
    runPostTool: (): Effect.Effect<HooksRunner.PostToolUseOutcome, never, never> =>
      Effect.succeed({ blocked: false }),
    runObserve: (): Effect.Effect<HooksRunner.SessionObserve, never, never> => Effect.succeed({}),
  }),
)

describe("hooks runner file executor", () => {
  fileDenyIt.effect("executor deny wins over plugin undecided", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const decision = yield* runner.runPreToolUse({
        sessionID: "ses_1",
        tool: "Bash",
        callID: "c1",
        args: { command: "ls" },
      })
      expect(decision).toEqual({ behavior: "deny", message: "file hook says no" })
    }),
  )
})

const fileRewriteIt = testEffect(
  HooksRunner.testLayerWithHooks([], {
    runDecision: (): Effect.Effect<HooksRunner.PreToolUseDecision, never, never> =>
      Effect.succeed({ behavior: "allow", updatedInput: { command: "ls --file" } }),
    runPostTool: (): Effect.Effect<HooksRunner.PostToolUseOutcome, never, never> =>
      Effect.succeed({ blocked: false }),
    runObserve: (): Effect.Effect<HooksRunner.SessionObserve, never, never> => Effect.succeed({}),
  }),
)

describe("hooks runner file rewrite", () => {
  fileRewriteIt.effect("executor allow+rewrite reaches the decision", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const decision = yield* runner.runPreToolUse({
        sessionID: "ses_1",
        tool: "Bash",
        callID: "c1",
        args: { command: "ls" },
      })
      expect(decision).toEqual({ behavior: "allow", updatedInput: { command: "ls --file" } })
    }),
  )
})

const seenIdle: Array<unknown> = []
const seenStart: Array<unknown> = []
const reasonIt = testEffect(
  HooksRunner.testLayerWithHooks([
    {
      "session.idle": async (input) => {
        seenIdle.push(input)
      },
      "session.start": async (input) => {
        seenStart.push(input)
      },
    },
  ]),
)

describe("hooks runner event fidelity", () => {
  reasonIt.effect("idle and interrupt emit distinct reasons", () =>
    Effect.gen(function* () {
      seenIdle.length = 0
      const runner = yield* HooksRunner.Service
      yield* runner.runIdle({ sessionID: "ses_1" })
      yield* runner.runInterrupt({ sessionID: "ses_1" })
      expect(seenIdle).toEqual([
        { sessionID: "ses_1", reason: "idle" },
        { sessionID: "ses_1", reason: "interrupt" },
      ])
    }),
  )

  reasonIt.effect("session start source passes through", () =>
    Effect.gen(function* () {
      seenStart.length = 0
      const runner = yield* HooksRunner.Service
      for (const source of ["startup", "resume", "clear", "compact"] as const) {
        yield* runner.runSessionStart({ sessionID: "ses_1", source })
      }
      expect(seenStart.map((item) => (item as { source: string }).source)).toEqual([
        "startup",
        "resume",
        "clear",
        "compact",
      ])
    }),
  )
})

const mutateAfterIt = testEffect(
  HooksRunner.testLayerWithHooks([
    {
      "tool.execute.after": async (_input, output) => {
        output.title = "renamed"
        output.output = `BLOCKED: ${output.output} (redacted)`
        output.metadata = { ...output.metadata, redacted: true }
      },
    },
  ]),
)

describe("hooks runner tool.execute.after", () => {
  mutateAfterIt.effect("plugin title/output/metadata mutations reach the tool result", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const result = yield* runner.runPostToolUse({
        sessionID: "ses_1",
        tool: "read",
        callID: "c1",
        args: {},
        result: { title: "a.ts", output: "secret", metadata: { lines: 1 } },
      })
      expect(result).toEqual({
        title: "renamed",
        output: "BLOCKED: secret (redacted)",
        metadata: { lines: 1, redacted: true },
      })
    }),
  )
})

const fileBlockIt = testEffect(
  HooksRunner.testLayerWithHooks([], {
    runDecision: () => Effect.succeed({ behavior: "undecided" as const }),
    runPostTool: () => Effect.succeed({ blocked: true as const, reason: "file hook blocked" }),
    runObserve: () => Effect.succeed({}),
  }),
)

describe("hooks runner file post block", () => {
  fileBlockIt.effect("a file hook block replaces the output only", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const result = yield* runner.runPostToolUse({
        sessionID: "ses_1",
        tool: "read",
        callID: "c1",
        args: {},
        result: { title: "a.ts", output: "secret", metadata: { lines: 1 } },
      })
      expect(result).toEqual({ title: "a.ts", output: "file hook blocked", metadata: { lines: 1 } })
    }),
  )
})
