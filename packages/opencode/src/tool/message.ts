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

const envelope = (input: { fromSession: string; fromAgent: string; message: string }) =>
  [
    `<peer_message from_session="${input.fromSession}" from_agent="${input.fromAgent}">`,
    input.message,
    "</peer_message>",
  ].join("\n")

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
      yield* runState.assertNotBusy(target.id)

      const title = `Message to ${target.title || target.id}`
      yield* ctx.metadata({
        title,
        metadata: { sessionID: target.id, agent: target.agent ?? ctx.agent },
      })

      // Deliver without blocking this turn: the peer session drains the
      // message in a forked fiber, mirroring background task result
      // injection. The busy guard above keeps delivery off active drains.
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
                message: params.message,
              }),
            },
          ],
        })
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))

      return {
        title,
        metadata: { sessionID: target.id },
        output:
          `Message delivered to session ${target.id}. It will be processed as a new turn in that session.` +
          " You will not receive a reply here; wait for the peer to report back or ask the user.",
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)