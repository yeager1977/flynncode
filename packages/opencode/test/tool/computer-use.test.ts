import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Schema } from "effect"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { ComputerUseTool } from "../../src/tool/computer-use"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Config.node, Truncate.node, Agent.node])))

const asked: unknown[] = []
const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (request: unknown) =>
    Effect.sync(() => {
      asked.push(request)
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

describe("computer-use fail-closed", () => {
  test("tool source requires enabled plus allowlist", async () => {
    const source = await Bun.file(new URL("../../src/tool/computer-use.ts", import.meta.url).pathname).text()
    expect(source).toContain("resolveComputerUse")
    expect(source).toContain("isAppAllowed")
    expect(source).toContain("computer_use")
    expect(source).toContain("ComputerUseDisabledError")
  })

  it.instance("fails while computer use is disabled", () =>
    Effect.gen(function* () {
      const info = yield* ComputerUseTool
      const tool = yield* info.init()
      const exit = yield* tool.execute({ action: "click", appID: "com.example.gui", x: 1, y: 1 }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance(
    "fails honestly for an allowed app instead of acknowledging the action",
    () =>
      Effect.gen(function* () {
        asked.length = 0
        const info = yield* ComputerUseTool
        const tool = yield* info.init()
        const exit = yield* tool.execute({ action: "click", appID: "com.example.gui", x: 1, y: 1 }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(failureMessage(exit)).toContain("not available in this build")
        expect(failureMessage(exit)).toContain("Do not assume it happened")
        expect(asked).toEqual([])
      }),
    { config: { computer_use: { enabled: true, allowedApps: ["com.example.gui"] } } },
  )
})
