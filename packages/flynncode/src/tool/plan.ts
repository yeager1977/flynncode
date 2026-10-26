import path from "path"
import { SessionV1 } from "@flynncode/core/v1/session"
import { FSUtil } from "@flynncode/core/fs-util"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID, type SessionID } from "../session/schema"
import ENTER_DESCRIPTION from "./plan-enter.txt"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const EnterParameters = Schema.Struct({
  reason: Schema.optional(Schema.String).annotate({
    description: "One sentence on why this task needs a plan before implementation",
  }),
})

export const ExitParameters = Schema.Struct({
  plan: Schema.String.annotate({
    description: "The complete plan in markdown. It is saved to the session's plan file and shown to the user.",
  }),
})

// The labels are part of the contract with the app's approval card.
export const APPROVE_ACCEPT_EDITS = "Approve — auto-accept edits"
export const APPROVE_MANUAL = "Approve — ask for each edit"
export const KEEP_PLANNING = "Keep planning"

export type EnterMetadata = {
  mode: "plan"
  reason?: string
  previousAgent: string
}

export type ExitMetadata =
  | { approved: true; approval: "accept-edits" | "manual"; planPath: string }
  | { approved: false; planPath: string; feedback?: string }

export const EnterPlanModeTool = Tool.define<
  typeof EnterParameters,
  EnterMetadata,
  Session.Service | Provider.Service | Agent.Service
>(
  "enter_plan_mode",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service

    return {
      description: ENTER_DESCRIPTION,
      parameters: EnterParameters,
      execute: (params: Schema.Schema.Type<typeof EnterParameters>, ctx: Tool.Context<EnterMetadata>) =>
        Effect.gen(function* () {
          const info = yield* session.get(ctx.sessionID).pipe(Effect.orDie)
          if (info.parentID) return yield* Effect.fail(new Error("Plan mode is not available in sub-agent sessions."))
          if (ctx.agent === "plan") return yield* Effect.fail(new Error("Plan mode is already active."))
          const plan = yield* agents.get("plan")
          if (!plan) return yield* Effect.fail(new Error("The plan agent is not available."))

          yield* switchAgent(session, provider, {
            sessionID: ctx.sessionID,
            agent: plan.name,
            text: params.reason
              ? `Switch to plan mode before implementing. Reason: ${params.reason}`
              : "Switch to plan mode before implementing.",
          })
          return {
            title: "Switched to plan mode",
            output:
              "Switched to plan mode. Explore and design without editing files, then call exit_plan_mode with the plan.",
            metadata: {
              mode: "plan" as const,
              ...(params.reason ? { reason: params.reason } : {}),
              previousAgent: ctx.agent,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const ExitPlanModeTool = Tool.define<
  typeof ExitParameters,
  ExitMetadata,
  Session.Service | Question.Service | Provider.Service | FSUtil.Service
>(
  "exit_plan_mode",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const fsys = yield* FSUtil.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: ExitParameters,
      execute: (params: Schema.Schema.Type<typeof ExitParameters>, ctx: Tool.Context<ExitMetadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID).pipe(Effect.orDie)
          const planPath = Session.plan(info, instance)
          const relative = path.relative(instance.worktree, planPath)
          yield* fsys.writeWithDirs(planPath, params.plan).pipe(Effect.orDie)

          // A dismissed question is a "keep planning" answer, not a tool error.
          const answers = yield* question
            .ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  question: `The plan at ${relative} is ready. Approve it to start implementing, or keep planning.`,
                  header: "Plan ready",
                  custom: true,
                  options: [
                    { label: APPROVE_ACCEPT_EDITS, description: "Switch to build and accept file edits automatically" },
                    { label: APPROVE_MANUAL, description: "Switch to build and ask before each file edit" },
                    { label: KEEP_PLANNING, description: "Stay in plan mode; type feedback to revise the plan" },
                  ],
                },
              ],
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            })
            .pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed([])))
          const answer = answers[0]?.[0]?.trim()

          if (answer === APPROVE_ACCEPT_EDITS || answer === APPROVE_MANUAL) {
            yield* switchAgent(session, provider, {
              sessionID: ctx.sessionID,
              agent: "build",
              text: `The plan at ${relative} has been approved; implement it.`,
            })
            return {
              title: "Plan approved",
              output: "The user approved the plan. Switching to the build agent to implement it.",
              metadata: {
                approved: true as const,
                approval: answer === APPROVE_ACCEPT_EDITS ? ("accept-edits" as const) : ("manual" as const),
                planPath,
              },
            }
          }

          const feedback = answer && answer !== KEEP_PLANNING ? answer : undefined
          return {
            title: "Keep planning",
            output: feedback
              ? `The user wants to keep planning and gave this feedback:\n\n${feedback}\n\nRevise the plan, then call exit_plan_mode again.`
              : "The user wants to keep planning. Ask what to change or refine the plan, then call exit_plan_mode again.",
            metadata: { approved: false as const, planPath, ...(feedback ? { feedback } : {}) },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// Switches the session's next loop turn to `agent` with a synthetic user
// message; the loop runs each turn with the latest user message's agent.
const switchAgent = Effect.fn("PlanTool.switchAgent")(function* (
  session: Session.Interface,
  provider: Provider.Interface,
  input: { sessionID: SessionID; agent: string; text: string },
) {
  const messages = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
  const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
  const model =
    lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()
  const msg: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.agent,
    model,
  }
  yield* session.updateMessage(msg)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.text,
    synthetic: true,
  } satisfies SessionV1.TextPart)
})
