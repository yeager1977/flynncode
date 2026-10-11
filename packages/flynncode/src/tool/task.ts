import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@flynncode/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission, sandboxRules } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { ConfigPermissionV1 } from "@flynncode/core/v1/config/permission"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { HooksRunner } from "@/hooks/runner"
import { HooksContext } from "@/hooks/context"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@flynncode/core/database/database"
import { Worktree } from "@/worktree"
import { InstanceStore } from "@/project/instance-store"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  isolation: Schema.optional(Schema.Literals(["inherit", "worktree"])).annotate({
    description: "Run the subagent in the parent directory (inherit) or in a temp worktree (worktree)",
  }),
  cleanup: Schema.optional(Schema.Literals(["retain", "dispose"])).annotate({
    description: "Keep the temp worktree after the task (retain) or mark it disposable on archive (dispose)",
  }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
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

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const worktreeSvc = yield* Worktree.Service
    const store = yield* InstanceStore.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const agentDefaults = cfg.agent?.[params.subagent_type]
      const isolation = params.isolation ?? agentDefaults?.isolation ?? "inherit"
      const cleanup = params.cleanup ?? "retain"
      const sandbox = agentDefaults?.sandbox
      // The child's effective sandbox mode: its own agent config wins over the
      // parent's inherited mode (which prefers parent session metadata, then
      // the parent agent's config). Named profiles like "restricted" and
      // unknown tolerant values leave the mode undefined, so the child falls
      // back to the global policy through its own resolution.
      const parentAgentName = parent.agent ?? ctx.agent
      const parentMetadataSandbox = parent.metadata?.sandbox
      const parentConfigSandbox = cfg.agent?.[parentAgentName]?.sandbox
      const parentMode = ConfigPermissionV1.isSandboxMode(parentMetadataSandbox)
        ? parentMetadataSandbox
        : ConfigPermissionV1.isSandboxMode(parentConfigSandbox)
          ? parentConfigSandbox
          : undefined
      const mode = ConfigPermissionV1.isSandboxMode(sandbox) ? sandbox : parentMode
      const sandboxMeta = mode ? { sandbox: mode } : undefined

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      // Fresh sessions isolate in a temp worktree named after the pending
      // child (unique per spawn, so siblings never collide). Resumed sessions
      // keep their existing directory.
      const isolated = isolation === "worktree" && !session
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const childRules = [
        ...childPermission,
        ...childToolDenies.filter(
          (deny) =>
            !childPermission.some(
              (rule) =>
                rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
            ),
        ),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: childRules,
        }))
      // Observe-only SubagentStart hook; continue:false is parsed but ignored.
      const maybeSubagentHooks = yield* Effect.serviceOption(HooksRunner.Service)
      if (Option.isSome(maybeSubagentHooks)) {
        yield* HooksContext.observeAndStore(
          "hooks.subagent.start",
          nextSession.id,
          maybeSubagentHooks.value.runSubagentStart({
            sessionID: nextSession.id,
            agentID: nextSession.id,
            agentType: next.name,
          }),
        )
      }
      // The child runs in the temp worktree: rebind its session row to the
      // worktree directory (the disposable binding also travels in metadata,
      // since there is no new session table), then append the sandbox profile
      // resolved against that directory.
      const worktreeInfo = isolated
        ? yield* worktreeSvc.createDisposable({ sessionID: nextSession.id }).pipe(
            // The tool boundary dies the error channel, so translate the typed
            // worktree failures into plain Error messages the model can act on.
            Effect.catch((error) =>
              error instanceof Worktree.NotGitError
                ? Effect.fail(new Error("isolation: worktree requires a git project"))
                : error instanceof Worktree.CreateFailedError
                  ? Effect.fail(new Error(`isolation: worktree could not be created: ${error.message}`))
                  : Effect.fail(error),
            ),
          )
        : undefined
      if (worktreeInfo) {
        yield* sessions.setDirectory({ sessionID: nextSession.id, directory: worktreeInfo.directory })
        yield* sessions.setPermission({
          sessionID: nextSession.id,
          permission: [
            ...childRules,
            ...sandboxRules({
              sandbox: sandbox ?? "inherit",
              directory: worktreeInfo.directory,
              agentPermission: next.permission,
            }),
          ],
        })
        // The archive handler reads this binding to dispose the worktree.
        yield* sessions.setMetadata({
          sessionID: nextSession.id,
          metadata: {
            ...nextSession.metadata,
            worktree: worktreeInfo.directory,
            disposable: cleanup === "dispose",
            ...sandboxMeta,
          },
        })
      }
      // Dispatched children carry their resolved sandbox mode in session
      // metadata so the child's tools resolution honors it there (session
      // metadata beats agent config; the carried value is the child's own
      // effective mode, so the two agree). Isolated children get it beside
      // the worktree binding above; non-isolated ones get it here.
      if (!worktreeInfo && sandboxMeta) {
        yield* sessions.setMetadata({
          sessionID: nextSession.id,
          metadata: { ...nextSession.metadata, ...sandboxMeta },
        })
      }
      // The child runs in its own instance when it lives elsewhere: a fresh
      // isolated worktree, or the worktree a resumed isolated task is bound
      // to. Prompt, cancel and teardown all target that instance.
      const childDirectory =
        worktreeInfo?.directory ?? (nextSession.directory !== parent.directory ? nextSession.directory : undefined)
      const inChild = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        childDirectory ? store.provide({ directory: childDirectory }, effect) : effect
      const disposable = worktreeInfo ? cleanup === "dispose" : nextSession.metadata?.disposable === true
      // Unload a disposable worktree's instance once the task finishes so the
      // archive path can remove it (it skips directories still loaded).
      const release = childDirectory && disposable ? store.disposeDirectory(childDirectory) : Effect.void

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
        ...(worktreeInfo
          ? { worktree: worktreeInfo.directory, disposable: cleanup === "dispose" }
          : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      // Cancelling loads the child instance to reach its run state, so
      // release it again afterwards.
      const cancel = inChild(ops.cancel(nextSession.id)).pipe(Effect.ensuring(release))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const prompt = ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts,
        })
        // Run the child under its own instance so its tools and working
        // directory resolve there. Prompt-part resolution stays in the parent
        // (the prompt was authored against the parent checkout).
        const result = yield* inChild(prompt).pipe(Effect.ensuring(release))
        if (result.info.role === "assistant" && result.info.error) {
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`))
        }
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => cancel)),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            // Observe-only SubagentStop hook; interruption reuses the existing
            // user-interrupt path via ops.cancel (no parallel mechanism).
            const maybeStopHooks = yield* Effect.serviceOption(HooksRunner.Service)
            if (Option.isSome(maybeStopHooks)) {
              yield* HooksContext.observe(
                "hooks.subagent.stop",
                maybeStopHooks.value.runSubagentStop({
                  sessionID: nextSession.id,
                  agentID: nextSession.id,
                  agentType: next.name,
                }),
              )
            }
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
