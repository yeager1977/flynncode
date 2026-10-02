export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer } from "effect"
import { AgentV2 } from "../agent"
import { BackgroundJob } from "../background-job"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { LocationServiceMap } from "../location-service-map"
import { SessionV2 } from "../session"
import { Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { Schema } from "effect"

export const name = "task"

export const description = [
  "Launch a specialized subagent to handle a task.",
  "A foreground call waits and returns the child's last text.",
  "background=true returns immediately. The parent is steered when the child finishes.",
  "Do not poll a background task. task_id resumes an existing child session.",
].join(" ")

export const Input = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description: "Resume this child session instead of creating a new one",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Run the agent in the background. The parent is notified when it finishes.",
  }),
})
export type Input = typeof Input.Type

export const Output = Schema.String
export type Output = typeof Output.Type

export type Dispatch = (input: Input, context: Tool.Context) => Effect.Effect<Output, ToolFailure>

// Dispatch registration is a stack so an unbind cannot clobber another active
// binder: the latest bound dispatch is used while at least one binder remains.
let bound: Dispatch[] = []

export const bind = (dispatch: Dispatch) => {
  bound.push(dispatch)
  return () => {
    const index = bound.indexOf(dispatch)
    if (index >= 0) bound.splice(index, 1)
  }
}

export const renderOutput = (input: {
  sessionID: string
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) => {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const makeDispatch = (input: {
  sessions: SessionV2.Interface
  locations: { readonly get: (ref: SessionSchema.Info["location"]) => Layer.Layer<AgentV2.Service, unknown, never> }
  jobs: BackgroundJob.Interface
}): Dispatch => {
  const sessions = input.sessions
  const locations = input.locations
  const jobs = input.jobs

  const lastText = (sessionID: SessionSchema.ID) =>
    Effect.gen(function* () {
      const messages = yield* sessions.messages({ sessionID, order: "desc", limit: 30 })
      for (const message of messages) {
        if (message.type !== "assistant") continue
        const text = message.content.findLast((item) => item.type === "text" && item.text.length > 0)
        if (text?.type === "text") return text.text
      }
      return ""
    }).pipe(Effect.mapError(() => new ToolFailure({ message: "Could not read the subagent result" })))

  const depth = (session: SessionSchema.Info) =>
    Effect.gen(function* () {
      let current = session
      let count = 0
      while (current.parentID) {
        count++
        current = yield* sessions.get(current.parentID)
      }
      return count
    }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unknown parent session" })))

  return (params, context) =>
    Effect.gen(function* () {
      if (params.task_id === context.sessionID) {
        return yield* new ToolFailure({ message: "Cannot send a task to the current session" })
      }
      const parent = yield* sessions.get(context.sessionID).pipe(
        Effect.mapError(() => new ToolFailure({ message: `Unknown session: ${context.sessionID}` })),
      )
      if ((yield* depth(parent)) >= 1) {
        return yield* new ToolFailure({ message: "Subagent depth limit reached (1)" })
      }
      const info = yield* Effect.gen(function* () {
        const agents = yield* AgentV2.Service
        return yield* agents.get(AgentV2.ID.make(params.subagent_type))
      }).pipe(
        Effect.provide(locations.get(parent.location)),
        Effect.mapError(() => new ToolFailure({ message: `Unknown agent type: ${params.subagent_type}` })),
      )
      if (!info) return yield* new ToolFailure({ message: `Unknown agent type: ${params.subagent_type}` })

      const existing = params.task_id
        ? yield* sessions.get(SessionSchema.ID.make(params.task_id)).pipe(
            Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
          )
        : undefined
      if (existing && existing.parentID !== context.sessionID) {
        return yield* new ToolFailure({ message: `Task ${params.task_id} is not a child of this session` })
      }
      const child =
        existing ??
        (yield* sessions.create({
          parentID: context.sessionID,
          location: parent.location,
          agent: info.id,
          model: info.model ?? parent.model,
          metadata: { title: params.description },
        }))
      const prompt = Prompt.fromUserMessage({ text: params.prompt })
      yield* sessions.prompt({ sessionID: child.id, prompt, delivery: "steer" }).pipe(
        Effect.mapError((error) => new ToolFailure({ message: error.message })),
      )

      const finish = Effect.gen(function* () {
        yield* sessions.resume(child.id).pipe(
          Effect.mapError((error) => new ToolFailure({ message: error.message })),
        )
        return yield* lastText(child.id).pipe(
          Effect.mapError((error) => new ToolFailure({ message: error.message })),
        )
      })

      if (params.background) {
        yield* jobs.start({
          id: child.id,
          type: name,
          title: params.description,
          metadata: { parentSessionId: context.sessionID, sessionId: child.id },
          run: finish.pipe(
            Effect.flatMap((text) =>
              sessions
                .prompt({
                  sessionID: context.sessionID,
                  delivery: "steer",
                  prompt: Prompt.fromUserMessage({
                    text: renderOutput({
                      sessionID: child.id,
                      state: "completed",
                      summary: `Background task completed: ${params.description}`,
                      text,
                    }),
                  }),
                })
                .pipe(Effect.as(text)),
            ),
            Effect.mapError((error) => (error instanceof ToolFailure ? error.message : String(error))),
          ),
        })
        return renderOutput({
          sessionID: child.id,
          state: "running",
          summary: params.description,
          text: "The task is working in the background. You will be notified when it finishes.",
        })
      }

      const text = yield* finish
      return renderOutput({
        sessionID: child.id,
        state: "completed",
        summary: params.description,
        text,
      })
    })
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output }],
          execute: (input, context) => {
            const dispatch = bound.at(-1)
            if (!dispatch) return Effect.fail(new ToolFailure({ message: "Task tool is not available" }))
            return dispatch(input, context)
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/task",
  layer,
  deps: [ToolRegistry.node],
})

export const bindNode = makeGlobalNode({
  name: "tool/task-bind",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const locations = yield* LocationServiceMap.Service
      const jobs = yield* BackgroundJob.Service
      bind(makeDispatch({ sessions, locations, jobs }))
    }),
  ),
  deps: [SessionV2.node, LocationServiceMap.node, BackgroundJob.node],
})
