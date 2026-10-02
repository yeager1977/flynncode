import { describe, expect, afterAll } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageTool, bind } from "@opencode-ai/core/tool/message"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const sender = SessionSchema.ID.make("ses_sender")
const target = SessionSchema.ID.make("ses_target")
const prompts: Array<{ sessionID: string; delivery?: string; text: string }> = []
let missing = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const recordPrompt = (input: {
  sessionID: SessionV2.ID
  prompt: { text: string }
  delivery?: "queue" | "steer"
}) =>
  Effect.gen(function* () {
    if (missing) return yield* new SessionV2.NotFoundError({ sessionID: input.sessionID })
    prompts.push({ sessionID: input.sessionID, delivery: input.delivery, text: input.prompt.text })
    return {
      admittedSeq: 1,
      id: "msg_peer",
      sessionID: input.sessionID,
      prompt: input.prompt,
      delivery: input.delivery ?? "steer",
      timeCreated: new Date(),
    } as never
  })

const sessions = Layer.mock(SessionV2.Service, {
  prompt: recordPrompt,
} as unknown as SessionV2.Interface)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, MessageTool.node]),
    [
      [PermissionV2.node, permission],
      [SessionV2.node, sessions],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const call = (sessionID: string, message: string) => ({
  sessionID: sender,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-message", name: MessageTool.name, input: { session_id: sessionID, message } },
})

describe("MessageTool", () => {
  const unbound = bind({
    sessions: { prompt: recordPrompt } as unknown as SessionV2.Interface,
  })
  afterAll(unbound)

  it.effect("steers another session without waiting", () =>
    Effect.gen(function* () {
      prompts.length = 0
      missing = false
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call(target, "hello"))).toMatchObject({
        type: "text",
        value: expect.stringContaining("steered"),
      })
      expect(prompts.map((item) => item.delivery)).toEqual(["steer"])
      expect(prompts[0]?.text).toContain(`from_session="${sender}"`)
    }),
  )

  it.effect("rejects a message to the current session", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* executeTool(registry, call(sender, "loop"))).toEqual({
        type: "error",
        value: "Cannot send a message to your own session",
      })
    }),
  )
})
