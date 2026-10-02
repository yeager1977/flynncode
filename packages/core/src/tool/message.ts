export * as MessageTool from "./message"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "message"

export const Input = Schema.Struct({
  session_id: Schema.String.annotate({
    description: "The target session ID",
  }),
  message: Schema.String.annotate({
    description: "The update or coordination request to deliver",
  }),
})

export const Output = Schema.Struct({
  sessionID: Schema.String,
  delivery: Schema.Literals(["steer", "queue"]),
})
export type Output = typeof Output.Type

const envelope = (input: { fromSession: string; fromAgent: string; correlation: string; message: string }) =>
  [
    `<peer_message from_session="${input.fromSession}" from_agent="${input.fromAgent}" correlation="${input.correlation}">`,
    input.message,
    "</peer_message>",
  ].join("\n")

// Dispatch data is bound process-globally like TaskTool: the location layer
// provides permission, the server bindNode layer provides the session service.
const bound: { sessions?: SessionV2.Interface }[] = []

export const bind = (data: { sessions: SessionV2.Interface }) => {
  bound.push(data)
  return () => {
    const index = bound.indexOf(data)
    if (index >= 0) bound.splice(index, 1)
  }
}

export const description =
  "Send a message to another session. It is steered into that session and promoted immediately if idle, or at the next safe turn boundary if busy. The sender does not wait for the reply."

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Message ${output.delivery === "steer" ? "steered into" : "queued for"} session ${output.sessionID}. Do not wait for the reply in this turn.`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.session_id === context.sessionID) {
                return yield* new ToolFailure({ message: "Cannot send a message to your own session" })
              }
              const data = bound.at(-1)
              if (!data?.sessions) return yield* new ToolFailure({ message: "Message tool is not available" })
              const target = SessionSchema.ID.make(input.session_id)
              const delivery = "steer" as const
              yield* permission
                .assert({
                  action: name,
                  resources: [target],
                  save: [target],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: message" })))
              yield* data.sessions
                .prompt({
                  sessionID: target,
                  delivery,
                  prompt: {
                    text: envelope({
                      fromSession: context.sessionID,
                      fromAgent: context.agent,
                      correlation: context.toolCallID,
                      message: input.message,
                    }),
                  },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Unknown session: ${target}` })))
              return { sessionID: target, delivery }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/message",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node],
})

export const bindNode = makeGlobalNode({
  name: "tool/message-bind",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      bind({ sessions })
    }),
  ),
  deps: [SessionV2.node],
})
