import { describe, expect, test } from "bun:test"
import type { Hooks } from "@flynncode/plugin"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { HooksRunner } from "../../src/hooks/runner"
import { testLayer, testLayerWithHooks } from "../lib/hooks"

test("hooks expose session lifecycle keys", () => {
  const keys: Array<keyof Hooks> = ["session.start", "session.end", "tool.permission"]
  expect(keys.length).toBe(3)
})

const it = testEffect(testLayer)

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
  testLayerWithHooks([
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
  testLayerWithHooks([
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
  testLayerWithHooks([], {
    runDecision: (): Effect.Effect<HooksRunner.PreToolUseDecision, never, never> =>
      Effect.succeed({ behavior: "deny", message: "file hook says no" }),
    runPostTool: (): Effect.Effect<HooksRunner.PostToolUseOutcome, never, never> =>
      Effect.succeed({ blocked: false }),
    runObserve: (): Effect.Effect<HooksRunner.SessionObserve, never, never> => Effect.succeed({}),
    hasHandlers: () => Effect.succeed(false),
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
  testLayerWithHooks([], {
    runDecision: (): Effect.Effect<HooksRunner.PreToolUseDecision, never, never> =>
      Effect.succeed({ behavior: "allow", updatedInput: { command: "ls --file" } }),
    runPostTool: (): Effect.Effect<HooksRunner.PostToolUseOutcome, never, never> =>
      Effect.succeed({ blocked: false }),
    runObserve: (): Effect.Effect<HooksRunner.SessionObserve, never, never> => Effect.succeed({}),
    hasHandlers: () => Effect.succeed(false),
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
  testLayerWithHooks([
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
  testLayerWithHooks([
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
  testLayerWithHooks([], {
    runDecision: () => Effect.succeed({ behavior: "undecided" as const }),
    runPostTool: () => Effect.succeed({ blocked: true as const, reason: "file hook blocked" }),
    runObserve: () => Effect.succeed({}),
    hasHandlers: () => Effect.succeed(false),
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

// Shared module-level collector for the mock executor below; each test
// clears it before use, so stale entries cannot leak into its assertions.
const seenDecision: Array<Record<string, unknown>> = []
const contextIt = testEffect(
  testLayerWithHooks([], {
    runDecision: (input) => {
      seenDecision.push(input as Record<string, unknown>)
      return Effect.succeed({ behavior: "undecided" })
    },
    runPostTool: () => Effect.succeed({ blocked: false } as const),
    runObserve: () => Effect.succeed({} as const),
    hasHandlers: () => Effect.succeed(false),
  }),
)

describe("hooks runner payload context", () => {
  contextIt.effect("model and permission mode pass through to the executor when provided", () =>
    Effect.gen(function* () {
      seenDecision.length = 0
      const runner = yield* HooksRunner.Service
      yield* runner.runPreToolUse({
        sessionID: "ses_1",
        tool: "Bash",
        callID: "c1",
        args: { command: "ls" },
        model: "prov/claude-x",
        permissionMode: "auto",
      })
      yield* runner.runPreToolUse({
        sessionID: "ses_1",
        tool: "Bash",
        callID: "c1",
        args: { command: "ls" },
      })
      expect(seenDecision.length).toBe(2)
      expect(seenDecision[0]?.["model"]).toBe("prov/claude-x")
      expect(seenDecision[0]?.["permissionMode"]).toBe("auto")
      // The runner passes the values through verbatim; the executor payload
      // drops them entirely when unknown (pinned in executor.test.ts).
      expect(seenDecision[1]?.["model"]).toBeUndefined()
      expect(seenDecision[1]?.["permissionMode"]).toBeUndefined()
    }),
  )
})

describe("hooks runner precedence", () => {
  test("deny > ask > allow > undecided", () => {
    const ask: HooksRunner.PreToolUseDecision = { behavior: "ask", message: "check" }
    const allow: HooksRunner.PreToolUseDecision = { behavior: "allow", updatedInput: { command: "ls" } }
    const deny: HooksRunner.PreToolUseDecision = { behavior: "deny", message: "no" }
    expect(HooksRunner.denyWins([allow, ask, { behavior: "undecided" }])).toEqual(ask)
    expect(HooksRunner.denyWins([ask, deny, allow])).toEqual(deny)
    expect(HooksRunner.denyWins([{ behavior: "undecided" }, allow])).toEqual(allow)
  })
})

const fileAskIt = testEffect(
  testLayerWithHooks(
    [
      {
        "tool.permission": async (_input, output) => {
          output.decision = "allow"
        },
      },
    ],
    {
      runDecision: (): Effect.Effect<HooksRunner.PreToolUseDecision, never, never> =>
        Effect.succeed({ behavior: "ask", message: "file hook asks" }),
      runPostTool: (): Effect.Effect<HooksRunner.PostToolUseOutcome, never, never> => Effect.succeed({ blocked: false }),
      runObserve: (): Effect.Effect<HooksRunner.SessionObserve, never, never> => Effect.succeed({}),
      hasHandlers: () => Effect.succeed(false),
    },
  ),
)

describe("hooks runner ask", () => {
  fileAskIt.effect("a file hook's ask beats a plugin allow", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const decision = yield* runner.runPreToolUse({ sessionID: "ses_1", tool: "bash", callID: "c1", args: { command: "ls" } })
      expect(decision).toEqual({ behavior: "ask", message: "file hook asks" })
    }),
  )
})

// A plugin whose subagent.stop throws, and file hooks for Stop only.
const stopIt = testEffect(
  testLayerWithHooks(
    [
      {
        "subagent.stop": async () => {
          throw new Error("plugin boom")
        },
      },
    ],
    {
      runDecision: () => Effect.succeed({ behavior: "undecided" as const }),
      runPostTool: () => Effect.succeed({ blocked: false as const }),
      runObserve: () => Effect.succeed({}),
      hasHandlers: (event) => Effect.succeed(event === "Stop"),
    },
  ),
)

describe("hooks runner stop", () => {
  stopIt.effect("hasStop sees file Stop hooks for a root and plugin subagent.stop for a child", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      expect(yield* runner.hasStop({ subagent: false })).toBe(true)
      expect(yield* runner.hasStop({ subagent: true })).toBe(true)
    }),
  )

  stopIt.effect("a throwing subagent.stop plugin lets the stop through", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      expect(yield* runner.runStop({ sessionID: "ses_1", subagent: true, agentType: "general", active: false })).toEqual(
        { block: false },
      )
    }),
  )
})

const noStopIt = testEffect(testLayerWithHooks([]))

describe("hooks runner without stop hooks", () => {
  noStopIt.effect("hasStop is false for a root and a child", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      expect(yield* runner.hasStop({ subagent: false })).toBe(false)
      expect(yield* runner.hasStop({ subagent: true })).toBe(false)
    }),
  )
})

describe("hooks runner notification gate", () => {
  noStopIt.effect("hasNotification is false with no hooks at all", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      expect(yield* runner.hasNotification()).toBe(false)
    }),
  )

  testEffect(
    testLayerWithHooks([], {
      runDecision: () => Effect.succeed({ behavior: "undecided" as const }),
      runPostTool: () => Effect.succeed({ blocked: false as const }),
      runObserve: () => Effect.succeed({}),
      hasHandlers: (event) => Effect.succeed(event === "Notification"),
    }),
  ).effect("hasNotification sees a Notification file hook", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      expect(yield* runner.hasNotification()).toBe(true)
    }),
  )

  testEffect(testLayerWithHooks([{ "session.notification": async () => {} }])).effect(
    "hasNotification sees a plugin session.notification hook",
    () =>
      Effect.gen(function* () {
        const runner = yield* HooksRunner.Service
        expect(yield* runner.hasNotification()).toBe(true)
      }),
  )
})

const startObserves: Array<{ event: string; nativeOnly?: boolean }> = []
const startIt = testEffect(
  testLayerWithHooks([], {
    runDecision: () => Effect.succeed({ behavior: "undecided" as const }),
    runPostTool: () => Effect.succeed({ blocked: false as const }),
    runObserve: (input) =>
      Effect.sync(() => {
        startObserves.push({ event: input.event, nativeOnly: input.nativeOnly })
        return {}
      }),
    hasHandlers: () => Effect.succeed(true),
  }),
)

describe("hooks runner SessionStart", () => {
  startIt.effect("a subagent's SessionStart runs native groups only", () =>
    Effect.gen(function* () {
      startObserves.length = 0
      const runner = yield* HooksRunner.Service
      yield* runner.runSessionStart({ sessionID: "ses_root", source: "startup" })
      yield* runner.runSessionStart({ sessionID: "ses_child", source: "startup", subagent: true })
      expect(startObserves).toEqual([
        { event: "SessionStart", nativeOnly: undefined },
        { event: "SessionStart", nativeOnly: true },
      ])
    }),
  )
})
