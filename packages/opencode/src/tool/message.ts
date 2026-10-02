import DESCRIPTION from "./message.txt"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { Effect, Schema, Scope } from "effect"
import { SessionID } from "../session/schema"
import * as Tool from "./tool"
import type { TaskPromptOps } from "./task"

export const Parameters = Schema.Struct({
  session_id: Schema.String.annotate({
    description:
      "The target session ID (for example the task_id of a subagent session started with the task tool)",
  }),
  message: Schema.String.annotate({
    description: "The update or coordination request to deliver to the target session's agent",
  }),
})

export const deliveryFor = (busy: boolean) => (busy ? "steer" : "queue")

const envelope = (input: { fromSession: string; fromAgent: string; correlation: string; message: string }) =>
  [
    `<peer_message from_session="${sanitizePeerField(input.fromSession)}" from_agent="${sanitizePeerField(input.fromAgent)}" correlation="${sanitizePeerField(input.correlation)}">`,
    input.message,
    "</peer_message>",
  ].join("\n")

// Header fields are interpolated into the envelope and later parsed by
// SessionPrompt.peerHeaderFrom; quotes or newlines would change the header
// structure (breaking routing or enabling forged headers).
const sanitizePeerField = (value: string) => value.replace(/["\r\n]/g, "")

export const MessageTool = Tool.define(
  "message",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service
    const scope = yield* Scope.Scope

    const run = Effect.fn("MessageTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("MessageTool requires promptOps in ctx.extra"))

      const target = yield* sessions
        .get(SessionID.make(params.session_id))
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!target) return yield* Effect.fail(new Error(`Unknown session: ${params.session_id}`))
      if (target.id === ctx.sessionID) {
        return yield* Effect.fail(new Error("Cannot send a message to your own session; reply directly instead"))
      }
      const busy = yield* runState.assertNotBusy(target.id).pipe(
        Effect.as(false),
        Effect.catch(() => Effect.succeed(true)),
      )
      const delivery = deliveryFor(busy)
      yield* ctx.ask({
        permission: "message",
        patterns: [target.id],
        always: [target.id],
        metadata: { sessionID: target.id },
      })

      const title = `Message to ${target.title || target.id}`
      yield* ctx.metadata({
        title,
        metadata: { sessionID: target.id, agent: target.agent ?? ctx.agent },
      })

      yield* ops
        .prompt({
          sessionID: target.id,
          agent: target.agent ?? ctx.agent,
          parts: [
              {
                type: "text",
                synthetic: true,
                text: envelope({
                  fromSession: ctx.sessionID,
                  fromAgent: ctx.agent,
                  correlation: ctx.messageID,
                  message: params.message,
                }),
              },
            ],
            delivery,
          })
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))

      return {
        title,
        metadata: { sessionID: target.id },
        output:
          `Message ${delivery === "steer" ? "steered into" : "queued for"} session ${target.id}. ` +
          "The peer reply will arrive in this session. Do not wait for it in this turn.",
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)