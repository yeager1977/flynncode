import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { MessageTool } from "../../src/tool/message"
import type { TaskPromptOps } from "../../src/tool/task"
import * as Tool from "../../src/tool/tool"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = () =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [],
  )

const it = testEffect(layer())

const recordingOps = () => {
  const calls: SessionPrompt.PromptInput[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        calls.push(input)
      }).pipe(
        Effect.as({
          info: { id: "msg", role: "user", sessionID: input.sessionID } as never,
          parts: [] as never,
        }),
      ),
  }
  return { calls, ops }
}

const ctx = (sessionID: any, ops: TaskPromptOps, agent = "build", asks: string[] = []) =>
  ({
    sessionID,
    messageID: MessageID.ascending(),
    agent,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (req: { permission: string }) =>
      Effect.sync(() => {
        asks.push(req.permission)
      }),
    extra: { promptOps: ops },
  }) as unknown as Tool.Context

describe("tool.message", () => {
  it.instance(
    "delivers a peer message envelope into the target session",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const sender = yield* sessions.create({ title: "lead" })
        const target = yield* sessions.create({ title: "worker" })
        const { calls, ops } = recordingOps()
        const asks: string[] = []
        const info = yield* MessageTool
        const def = yield* Tool.init(info)

        yield* def.execute(
          { session_id: target.id, message: "found the failing test" },
          ctx(sender.id, ops, "build", asks),
        )

        expect(asks).toEqual(["message"])

        expect(calls.length).toBe(1)
        expect(calls[0].sessionID).toBe(target.id)
        const part = calls[0].parts[0] as { type: string; synthetic?: boolean; text: string }
        expect(part.type).toBe("text")
        expect(part.synthetic).toBe(true)
        expect(part.text).toContain(`from_session="${sender.id}"`)
        expect(part.text).toContain('from_agent="build"')
        expect(part.text).toContain("found the failing test")
      }),
  )

  it.instance(
    "fails clearly for an unknown session",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const sender = yield* sessions.create({ title: "lead" })
        const { ops } = recordingOps()
        const info = yield* MessageTool
        const def = yield* Tool.init(info)

        const exit = yield* def
          .execute({ session_id: "ses_missing", message: "hello" }, ctx(sender.id, ops))
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
  )

  it.instance(
    "rejects sending to the caller's own session",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const self = yield* sessions.create({ title: "lead" })
        const { calls, ops } = recordingOps()
        const info = yield* MessageTool
        const def = yield* Tool.init(info)

        const exit = yield* def
          .execute({ session_id: self.id, message: "loop" }, ctx(self.id, ops))
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls.length).toBe(0)
      }),
  )
})