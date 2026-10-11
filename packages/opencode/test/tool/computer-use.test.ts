import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Config } from "@/config/config"
import { ComputerUse } from "../../src/config/computer-use"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { ComputerUseExecutor } from "../../src/computer-use"
import { ComputerUseTool } from "../../src/tool/computer-use"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const fakeExecutorLayer = Layer.mock(ComputerUseExecutor.Service, {
  execute: (request: ComputerUseExecutor.ExecuteRequest) => {
    lastRequest = request
    return Effect.succeed(lastResult)
  },
  reply: () => Effect.void,
  list: () => Effect.succeed([] as Array<ComputerUseExecutor.Request>),
})

let lastRequest: ComputerUseExecutor.ExecuteRequest | undefined
let lastResult: ComputerUseExecutor.Result = { ok: true, output: "acted" }

const baseLayer = LayerNode.compile(LayerNode.group([Config.node, Truncate.node, Agent.node]))
// Tool runs that exercise the wired path get a fake executor; the fail-closed
// tests deliberately run without it so availability is checked, not assumed.
const it = testEffect(Layer.merge(baseLayer, fakeExecutorLayer))
const itBase = testEffect(baseLayer)

const asked: Array<{ permission: string; patterns: ReadonlyArray<string> }> = []
const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (request: { permission: string; patterns: ReadonlyArray<string> }) =>
    Effect.sync(() => {
      asked.push({ permission: request.permission, patterns: [...request.patterns] })
    }),
}

const failureMessage = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

describe("computer-use parameters", () => {
  test("accepts screenshot action with appID", () => {
    const decoded = Schema.decodeUnknownSync(ComputerUseTool.parameters)({ action: "screenshot", appID: "com.example.gui" })
    expect(decoded.action).toBe("screenshot")
  })

  test("rejects unknown action", () => {
    expect(() => Schema.decodeUnknownSync(ComputerUseTool.parameters)({ action: "reboot", appID: "com.example.gui" })).toThrow()
  })
})

describe("computer-use tiers", () => {
  test("screenshot is the observe tier, every input action is the mutate tier", () => {
    expect(ComputerUse.actionTier("screenshot")).toBe("observe")
    expect(ComputerUse.actionTier("click")).toBe("mutate")
    expect(ComputerUse.actionTier("keypress")).toBe("mutate")
  })

  test("tiers default to enabled; explicit disables tighten", () => {
    const base = ComputerUse.resolveComputerUse({ enabled: true, allowedApps: ["a"] })
    expect(base.tiers).toEqual({ observe: true, mutate: true })
    expect(ComputerUse.resolveComputerUse({
      enabled: true,
      allowedApps: ["a"],
      tiers: { observe: { enabled: false } },
    }).tiers).toEqual({ observe: false, mutate: true })
    // Undecodable tier values fail closed; unknown tier keys are tolerated.
    expect(ComputerUse.resolveComputerUse({
      enabled: true,
      allowedApps: ["a"],
      tiers: { mutate: "no" },
    }).tiers).toEqual({ observe: true, mutate: false })
    expect(ComputerUse.resolveComputerUse({
      enabled: true,
      allowedApps: ["a"],
      tiers: { filesystem: { enabled: true } },
    }).tiers).toEqual({ observe: true, mutate: true })
  })

  test("tier map semantics gate actions", () => {
    expect(ComputerUse.isTierAllowed("screenshot", { observe: true, mutate: false })).toBe(true)
    expect(ComputerUse.isTierAllowed("click", { observe: true, mutate: false })).toBe(false)
  })
})

describe("computer-use fail-closed", () => {
  test("tool source requires enabled plus allowlist", async () => {
    const source = await Bun.file(new URL("../../src/tool/computer-use.ts", import.meta.url).pathname).text()
    expect(source).toContain("resolveComputerUse")
    expect(source).toContain("isAppAllowed")
    expect(source).toContain("computer_use")
    expect(source).toContain("ComputerUseDisabledError")
  })

  itBase.instance("fails while computer use is disabled", () =>
    Effect.gen(function* () {
      const info = yield* ComputerUseTool
      const tool = yield* info.init()
      const exit = yield* tool.execute({ action: "click", appID: "com.example.gui", x: 1, y: 1 }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  itBase.instance(
    "fails before the ask when no executor is available",
    () =>
      Effect.gen(function* () {
        asked.length = 0
        const info = yield* ComputerUseTool
        const tool = yield* info.init()
        const exit = yield* tool.execute({ action: "click", appID: "com.example.gui", x: 1, y: 1 }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(failureMessage(exit)).toContain("not performed")
        expect(asked).toEqual([])
      }),
    { config: { computer_use: { enabled: true, allowedApps: ["com.example.gui"] } } },
  )

  itBase.instance(
    "fails before the ask when the action's tier is disabled",
    () =>
      Effect.gen(function* () {
        asked.length = 0
        const info = yield* ComputerUseTool
        const tool = yield* info.init()
        const exit = yield* tool.execute({ action: "click", appID: "flynncode:browser-pane", x: 1, y: 1 }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(failureMessage(exit)).toContain("mutate tier is disabled")
        expect(asked).toEqual([])
      }),
    { config: { computer_use: { enabled: true, allowedApps: ["flynncode:browser-pane"], tiers: { mutate: { enabled: false } } } } },
  )

  it.instance(
    "asks once with the appID and action patterns and dispatches to the executor",
    () =>
      Effect.gen(function* () {
        asked.length = 0
        lastRequest = undefined
        lastResult = { ok: true, output: "clicked" }
        const info = yield* ComputerUseTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { action: "click", appID: "flynncode:browser-pane", x: 10, y: 20 },
          ctx,
        )
        expect(asked).toEqual([{ permission: "computer_use", patterns: ["flynncode:browser-pane", "click"] }])
        expect(lastRequest).toEqual({
          sessionID: "ses_test",
          action: "click",
          appID: "flynncode:browser-pane",
          args: { x: 10, y: 20 },
        })
        expect(result.output).toBe("clicked")
      }),
    {
      config: {
        computer_use: {
          enabled: true,
          allowedApps: ["flynncode:browser-pane"],
        },
      },
    },
  )

  it.instance(
    "returns the screenshot as a png attachment",
    () =>
      Effect.gen(function* () {
        lastResult = { ok: true, screenshot: "data:image/png;base64,AAAA" }
        const info = yield* ComputerUseTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ action: "screenshot", appID: "flynncode:browser-pane" }, ctx)
        expect(result.attachments).toEqual([
          { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
        ])
      }),
    { config: { computer_use: { enabled: true, allowedApps: ["flynncode:browser-pane"] } } },
  )

  it.instance(
    "reports refused actions honestly without acknowledging execution",
    () =>
      Effect.gen(function* () {
        lastResult = { ok: false, error: "app is not allowlisted for computer use" }
        const info = yield* ComputerUseTool
        const tool = yield* info.init()
        const exit = yield* tool.execute({ action: "screenshot", appID: "flynncode:browser-pane" }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(failureMessage(exit)).toContain("was not performed")
      }),
    { config: { computer_use: { enabled: true, allowedApps: ["flynncode:browser-pane"] } } },
  )

  it.instance(
    "reports unconfirmed outcomes as unknown instead of unperformed",
    () =>
      Effect.gen(function* () {
        lastResult = { ok: false, error: "reply delivery failed; the outcome is unconfirmed", unconfirmed: true }
        const info = yield* ComputerUseTool
        const tool = yield* info.init()
        const exit = yield* tool.execute({ action: "click", appID: "flynncode:browser-pane", x: 1, y: 1 }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(failureMessage(exit)).toContain("may or may not have been performed")
      }),
    { config: { computer_use: { enabled: true, allowedApps: ["flynncode:browser-pane"] } } },
  )
})
