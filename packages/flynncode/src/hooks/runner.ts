import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { Plugin } from "@/plugin"
import { HooksExecutor, type ExecutorInterface } from "@/hooks/executor"
import { HooksTrust } from "@/hooks/trust"

export type PreToolUseDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; additionalContext?: string }
  // `stop`: a Claude hook's `continue: false`; the turn also ends after this
  // tool step.
  | { behavior: "deny"; message: string; stop?: boolean }
  // The call must be confirmed: its own permission check prompts even where a
  // rule or an "always" approval allows (rule denies still deny), and a tool
  // without a check of its own gets one prompt before it runs. The prompt shows
  // `updatedInput` in its patterns and metadata, and that input runs if the
  // user approves.
  | { behavior: "ask"; message?: string; additionalContext?: string; updatedInput?: Record<string, unknown> }
  | { behavior: "undecided"; additionalContext?: string }

export type PostToolUseOutcome =
  | { blocked: true; reason: string; stop?: boolean }
  | { blocked: false; additionalContext?: string }

// The model-visible slice of a tool result that `tool.execute.after` plugins
// may mutate in place.
export type ToolResultView = {
  title: string
  output: string
  metadata: Record<string, unknown>
}

export type SessionObserve = {
  additionalContext?: string
  systemMessage?: string
  continue?: boolean
  stopReason?: string
  // UserPromptSubmit, Stop and SubagentStop only: a hook blocked. The prompt
  // is not admitted, or the stop is refused and the reason continues the turn.
  block?: { reason: string }
}

export class HookDeniedError extends Error {
  readonly _tag = "HookDeniedError"
  constructor(message: string) {
    super(message)
    this.name = "HookDeniedError"
  }
}

export interface RunnerInterface {
  readonly runPreToolUse: (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
    model?: string
    permissionMode?: string
  }) => Effect.Effect<PreToolUseDecision>
  readonly runPermissionRequest: (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
    permissionMode?: string
  }) => Effect.Effect<PreToolUseDecision>
  readonly runPermissionAsk: (input: {
    permission: string
    patterns: ReadonlyArray<string>
    sessionID: string
    metadata: Record<string, unknown>
    tool?: string
    args?: Record<string, unknown>
    id?: string
    callID?: string
    messageID?: string
  }) => Effect.Effect<"ask" | "deny" | "allow">
  readonly runPostToolUse: (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
    result: ToolResultView
    model?: string
    permissionMode?: string
    // `stop`: a hook's `continue: false`; the turn ends after this tool step.
  }) => Effect.Effect<ToolResultView & { stop?: boolean }>
  // Runs instead of runPostToolUse when the tool failed or was interrupted.
  // A block reason or additional context is for the model, next to the error.
  readonly runPostToolUseFailure: (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
    error: string
    interrupted: boolean
    model?: string
    permissionMode?: string
  }) => Effect.Effect<PostToolUseOutcome>
  // Observe-only: the user is being waited on. `tool` is the Flynncode tool id
  // a permission prompt's message ends with; Claude hooks see its Claude name.
  readonly runNotification: (input: {
    sessionID: string
    message: string
    type: NotificationType
    tool?: string
  }) => Effect.Effect<void>
  // Whether runNotification could run anything: a Notification file hook or a
  // plugin session.notification hook. Like hasStop, it reads only the loaded
  // config and plugins, so callers can skip forking the notification at all.
  readonly hasNotification: () => Effect.Effect<boolean>
  // `subagent`: a child session. Claude Code never runs SessionStart for its
  // subagents, so Claude-format groups are skipped; native hooks and plugins
  // still run.
  readonly runSessionStart: (input: {
    sessionID: string
    source: "startup" | "resume" | "clear" | "compact"
    subagent?: boolean
  }) => Effect.Effect<SessionObserve>
  readonly runSessionEnd: (input: { sessionID: string }) => Effect.Effect<void>
  readonly runSessionPrompt: (input: { sessionID: string; prompt: string }) => Effect.Effect<SessionObserve>
  readonly runCompact: (input: {
    sessionID: string
    trigger: "manual" | "auto"
    phase: "pre" | "post"
  }) => Effect.Effect<SessionObserve>
  readonly runSubagentStart: (input: {
    sessionID: string
    agentID: string
    agentType: string
  }) => Effect.Effect<SessionObserve>
  // Always a no-op: the prompt loop fires SubagentStop for every child turn
  // that ends on its own (runStop), so the task tool's call after the child
  // returns fires nothing.
  readonly runSubagentStop: (input: {
    sessionID: string
    agentID: string
    agentType: string
  }) => Effect.Effect<SessionObserve>
  // Stop (a root session) or SubagentStop (a child session) at the end of the
  // prompt loop, before the session goes idle. A block refuses the stop: the
  // reason continues the turn. `active` is stop_hook_active: this stop follows
  // a continuation forced by a Stop hook for the same user prompt. A hook or
  // plugin failure lets the stop through: a finished turn never fails because
  // of a hook.
  readonly runStop: (input: {
    sessionID: string
    subagent: boolean
    agentID?: string
    agentType?: string
    active: boolean
  }) => Effect.Effect<{ block: boolean; reason?: string }>
  // Whether runStop could run anything: a Stop (root) or SubagentStop (child)
  // file hook, or a plugin subagent.stop hook for a child. It reads only the
  // loaded config and plugins, so a turn end without such hooks costs nothing.
  readonly hasStop: (input: { subagent: boolean }) => Effect.Effect<boolean>
  // The plugin session.idle hook on every idle transition. The Stop event no
  // longer fires here: it runs blocking in the prompt loop (runStop).
  readonly runIdle: (input: { sessionID: string; reason?: "idle" | "interrupt" }) => Effect.Effect<SessionObserve>
  readonly runInterrupt: (input: { sessionID: string }) => Effect.Effect<SessionObserve>
}

export type NotificationType = "permission_prompt" | "question" | "idle"

export class Service extends Context.Service<Service, RunnerInterface>()("@opencode/HooksRunner") {}

// deny > ask > allow (a rewrite first) > undecided.
export function denyWins(decisions: Array<PreToolUseDecision>): PreToolUseDecision {
  const denied = decisions.find((decision) => decision.behavior === "deny")
  if (denied) return denied
  const asked = decisions.find((decision) => decision.behavior === "ask")
  if (asked) return asked
  const rewritten = decisions.find((decision) => decision.behavior === "allow" && decision.updatedInput)
  if (rewritten) return rewritten
  const allowed = decisions.find((decision) => decision.behavior === "allow")
  if (allowed) return allowed
  return { behavior: "undecided" }
}

export type TriggerLike = {
  trigger: Plugin.Interface["trigger"]
  triggerDecision: Plugin.Interface["triggerDecision"]
  triggerPermissionAsk: Plugin.Interface["triggerPermissionAsk"]
  list: Plugin.Interface["list"]
}

export type ExecutorLike = Pick<ExecutorInterface, "runDecision" | "runPostTool" | "runObserve" | "hasHandlers">

function withContext(
  base: PreToolUseDecision,
  extra: PreToolUseDecision | undefined,
): PreToolUseDecision {
  if (!extra || extra.behavior === "deny") return base
  if (!extra.additionalContext) return base
  if (base.behavior === "deny" || !base.additionalContext) {
    if (base.behavior === "deny") return base
    return { ...base, additionalContext: extra.additionalContext }
  }
  return { ...base, additionalContext: `${base.additionalContext}\n\n${extra.additionalContext}` }
}

function mergeObserve(first: SessionObserve, second: SessionObserve): SessionObserve {
  const contexts = [first.additionalContext, second.additionalContext].filter(
    (part): part is string => part !== undefined && part !== "",
  )
  const continued =
    first.continue === false || second.continue === false ? false : (first.continue ?? second.continue)
  return {
    additionalContext: contexts.length > 0 ? contexts.join("\n\n") : undefined,
    systemMessage: first.systemMessage ?? second.systemMessage,
    continue: continued,
    stopReason: first.stopReason ?? second.stopReason,
    ...((first.block ?? second.block) && { block: first.block ?? second.block }),
  }
}

export function createRunner(plugin: TriggerLike, executor?: ExecutorLike): RunnerInterface {
  const runPreToolUse = Effect.fn("HooksRunner.runPreToolUse")(function* (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
    model?: string
    permissionMode?: string
  }) {
    // Fail closed: permission deny short-circuits before any rewrite or execution.
    const verdict = yield* plugin.triggerDecision(
      { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: input.args },
      { decision: "undecided" as const, message: undefined, updatedInput: undefined },
    )
    if (verdict.decision === "deny") return { behavior: "deny", message: verdict.message ?? "Denied by hook" } as const
    const fileVerdict = executor
      ? yield* executor.runDecision({
          event: "PreToolUse",
          matchName: input.tool,
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
          args: input.args,
          model: input.model,
          permissionMode: input.permissionMode,
        })
      : undefined
    if (fileVerdict?.behavior === "deny") return fileVerdict
    const fileRewrite =
      fileVerdict && (fileVerdict.behavior === "allow" || fileVerdict.behavior === "ask")
        ? fileVerdict.updatedInput
        : undefined
    const output = { args: verdict.updatedInput ?? fileRewrite ?? input.args }
    yield* plugin.trigger(
      "tool.execute.before",
      { tool: input.tool, sessionID: input.sessionID, callID: input.callID },
      output,
    )
    if (output.args !== input.args) {
      // A file hook's ask still prompts, now for the rewritten input.
      if (fileVerdict?.behavior === "ask") return { ...fileVerdict, updatedInput: output.args }
      const rewritten: PreToolUseDecision = { behavior: "allow", updatedInput: output.args }
      return withContext(rewritten, fileVerdict)
    }
    if (fileVerdict && fileVerdict.behavior !== "undecided") return fileVerdict
    if (verdict.decision === "allow") {
      if (verdict.updatedInput) return { behavior: "allow", updatedInput: verdict.updatedInput } as const
      return { behavior: "allow" } as const
    }
    return withContext({ behavior: "undecided" } as const, fileVerdict)
  })

  // The plugin permission.ask hook runs before the pending prompt: any deny
  // fails the ask like a config rule, allow/ask fall through to the normal
  // PermissionRequest hook and prompt flow.
  const runPermissionAsk = Effect.fn("HooksRunner.runPermissionAsk")(function* (input: {
    permission: string
    patterns: ReadonlyArray<string>
    sessionID: string
    metadata: Record<string, unknown>
    tool?: string
    args?: Record<string, unknown>
    id?: string
    callID?: string
    messageID?: string
  }) {
    return (yield* plugin.triggerPermissionAsk(input, { status: "ask" as const })).status
  })

  const runPermissionRequest = Effect.fn("HooksRunner.runPermissionRequest")(function* (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
    permissionMode?: string
  }) {
    const output: {
      decision: "allow" | "deny" | "undecided"
      message: string | undefined
      updatedInput: Record<string, unknown> | undefined
    } = {
      decision: "undecided",
      message: undefined,
      updatedInput: undefined,
    }
    yield* plugin.triggerDecision(
      { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: input.args },
      output,
    )
    const fileVerdict = executor
      ? yield* executor.runDecision({
          event: "PermissionRequest",
          matchName: input.tool,
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
          args: input.args,
          permissionMode: input.permissionMode,
        })
      : undefined
    // Fail closed on malformed hook output: unknown decision shapes fall through
    // as undecided only when explicitly undecided; deny always wins.
    if (output.decision === "deny") return { behavior: "deny", message: output.message ?? "Denied by hook" } as const
    if (fileVerdict?.behavior === "deny") return fileVerdict
    const pluginDecision: PreToolUseDecision =
      output.decision === "allow"
        ? output.updatedInput
          ? { behavior: "allow", updatedInput: output.updatedInput }
          : { behavior: "allow" }
        : { behavior: "undecided" }
    const combined = denyWins([pluginDecision, fileVerdict ?? { behavior: "undecided" }])
    return withContext(combined, fileVerdict)
  })

  const runPostToolUse = Effect.fn("HooksRunner.runPostToolUse")(function* (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
    result: ToolResultView
    model?: string
    permissionMode?: string
  }) {
    // Plugins mutate this view in place; their title/output/metadata edits are
    // the tool result the model sees. Only a file hook's block replaces it.
    const view: ToolResultView = {
      title: input.result.title,
      output: input.result.output,
      metadata: { ...input.result.metadata },
    }
    yield* plugin.trigger(
      "tool.execute.after",
      { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: input.args },
      view,
    )
    if (!executor) return view
    const filePost = yield* executor.runPostTool({
      tool: input.tool,
      matchName: input.tool,
      sessionID: input.sessionID,
      callID: input.callID,
      args: input.args,
      output: view.output,
      model: input.model,
      permissionMode: input.permissionMode,
    })
    if (filePost.blocked) return { ...view, output: filePost.reason, ...(filePost.stop && { stop: true }) }
    return view
  })

  const runPostToolUseFailure = Effect.fn("HooksRunner.runPostToolUseFailure")(function* (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
    error: string
    interrupted: boolean
    model?: string
    permissionMode?: string
  }) {
    yield* plugin.trigger(
      "tool.execute.failure",
      {
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        args: input.args,
        error: input.error,
        interrupted: input.interrupted,
      },
      {},
    )
    if (!executor) return { blocked: false } as const
    return yield* executor.runPostTool({
      event: "PostToolUseFailure",
      tool: input.tool,
      matchName: input.tool,
      sessionID: input.sessionID,
      callID: input.callID,
      args: input.args,
      error: input.error,
      interrupted: input.interrupted,
      model: input.model,
      permissionMode: input.permissionMode,
    })
  })

  const runNotification = Effect.fn("HooksRunner.runNotification")(function* (input: {
    sessionID: string
    message: string
    type: NotificationType
    tool?: string
  }) {
    yield* plugin.trigger("session.notification", { sessionID: input.sessionID, message: input.message, type: input.type }, {})
    if (!executor) return
    yield* executor.runObserve({
      event: "Notification",
      matchName: input.type,
      sessionID: input.sessionID,
      payload: {
        message: input.message,
        notificationType: input.type,
        ...(input.tool !== undefined && { tool: input.tool }),
      },
    })
  })

  const hasNotification = Effect.fn("HooksRunner.hasNotification")(function* () {
    if ((yield* plugin.list()).some((hooks) => hooks["session.notification"] !== undefined)) return true
    if (!executor) return false
    return yield* executor.hasHandlers("Notification")
  })

  const runSessionStart = Effect.fn("HooksRunner.runSessionStart")(function* (input: {
    sessionID: string
    source: "startup" | "resume" | "clear" | "compact"
    subagent?: boolean
  }) {
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("session.start", { sessionID: input.sessionID, source: input.source }, output)
    const pluginObserve: SessionObserve = { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
    if (!executor) return pluginObserve
    return mergeObserve(
      pluginObserve,
      yield* executor.runObserve({
        event: "SessionStart",
        matchName: input.source,
        sessionID: input.sessionID,
        payload: { source: input.source },
        nativeOnly: input.subagent,
      }),
    )
  })

  const runSessionEnd = Effect.fn("HooksRunner.runSessionEnd")(function* (input: { sessionID: string }) {
    // Advisory only: SessionEnd output never steers.
    yield* plugin.trigger(
      "session.end",
      { sessionID: input.sessionID, reason: "other" as const },
      { systemMessage: undefined as string | undefined },
    )
    if (!executor) return
    yield* executor
      .runObserve({
        event: "SessionEnd",
        matchName: "",
        sessionID: input.sessionID,
        payload: { reason: "other" },
        timeoutMaxMs: 3000,
        defaultTimeoutMs: 1000,
      })
      .pipe(Effect.ignore)
  })

  const runSessionPrompt = Effect.fn("HooksRunner.runSessionPrompt")(function* (input: {
    sessionID: string
    prompt: string
  }) {
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("session.prompt", input, output)
    const pluginObserve: SessionObserve = { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
    if (!executor) return pluginObserve
    return mergeObserve(
      pluginObserve,
      yield* executor.runObserve({
        event: "UserPromptSubmit",
        matchName: "",
        sessionID: input.sessionID,
        payload: { prompt: input.prompt },
      }),
    )
  })

  const runCompact = Effect.fn("HooksRunner.runCompact")(function* (input: {
    sessionID: string
    trigger: "manual" | "auto"
    phase: "pre" | "post"
  }) {
    const output = {
      additionalContext: undefined as string | undefined,
      systemMessage: undefined as string | undefined,
      continue: true as boolean | undefined,
    }
    yield* plugin.trigger("session.compact", input, output)
    const pluginObserve: SessionObserve = {
      additionalContext: output.additionalContext,
      systemMessage: output.systemMessage,
      continue: output.continue,
    }
    if (!executor) return pluginObserve
    return mergeObserve(
      pluginObserve,
      yield* executor.runObserve({
        event: input.phase === "pre" ? "PreCompact" : "PostCompact",
        matchName: input.trigger,
        sessionID: input.sessionID,
        payload: { trigger: input.trigger, phase: input.phase },
      }),
    )
  })

  const runSubagentStart = Effect.fn("HooksRunner.runSubagentStart")(function* (input: {
    sessionID: string
    agentID: string
    agentType: string
  }) {
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("subagent.start", input, output)
    // continue:false on SubagentStart is parsed but ignored per trust model.
    const pluginObserve: SessionObserve = { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
    if (!executor) return pluginObserve
    return mergeObserve(
      pluginObserve,
      yield* executor.runObserve({
        event: "SubagentStart",
        matchName: input.agentType,
        sessionID: input.sessionID,
        payload: { agentID: input.agentID, agentType: input.agentType },
      }),
    )
  })

  const runSubagentStop = Effect.fn("HooksRunner.runSubagentStop")(function* (_input: {
    sessionID: string
    agentID: string
    agentType: string
  }) {
    return {} satisfies SessionObserve
  })

  const runStop = Effect.fn("HooksRunner.runStop")(function* (input: {
    sessionID: string
    subagent: boolean
    agentID?: string
    agentType?: string
    active: boolean
  }) {
    const agentID = input.agentID ?? input.sessionID
    const agentType = input.agentType ?? ""
    if (input.subagent) {
      const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
      yield* plugin.trigger("subagent.stop", { sessionID: input.sessionID, agentID, agentType }, output)
      if (output.systemMessage) yield* Effect.logWarning("hooks.subagent.stop", { systemMessage: output.systemMessage })
    }
    if (!executor) return { block: false }
    const observe = yield* executor.runObserve(
      input.subagent
        ? {
            event: "SubagentStop",
            matchName: agentType,
            sessionID: input.sessionID,
            payload: { agentID, agentType, stopHookActive: input.active },
          }
        : {
            event: "Stop",
            matchName: "idle",
            sessionID: input.sessionID,
            payload: { reason: "idle", stopHookActive: input.active },
          },
    )
    if (observe.systemMessage) {
      yield* Effect.logWarning(input.subagent ? "hooks.subagent.stop" : "hooks.session.stop", {
        systemMessage: observe.systemMessage,
      })
    }
    if (!observe.block) return { block: false }
    return { block: true, reason: observe.block.reason }
  }, Effect.catchDefect((defect) =>
    Effect.logWarning("stop hook failed; letting the turn stop", {
      error: defect instanceof Error ? defect.message : String(defect),
    }).pipe(Effect.as({ block: false })),
  ))

  const hasStop = Effect.fn("HooksRunner.hasStop")(function* (input: { subagent: boolean }) {
    if (input.subagent && (yield* plugin.list()).some((hooks) => hooks["subagent.stop"] !== undefined)) return true
    if (!executor) return false
    return yield* executor.hasHandlers(input.subagent ? "SubagentStop" : "Stop")
  })

  const runIdle = Effect.fn("HooksRunner.runIdle")(function* (input: { sessionID: string; reason?: "idle" | "interrupt" }) {
    const reason = input.reason ?? "idle"
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("session.idle", { sessionID: input.sessionID, reason }, output)
    return { additionalContext: output.additionalContext, systemMessage: output.systemMessage } satisfies SessionObserve
  })

  const runInterrupt = Effect.fn("HooksRunner.runInterrupt")(function* (input: { sessionID: string }) {
    // Reuses the existing user-interrupt path: advisory observe hook only,
    // no parallel interruption mechanism. Emits reason "interrupt" so it is
    // distinguishable from idle ("Stop" event carries the reason).
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("session.idle", { sessionID: input.sessionID, reason: "interrupt" as const }, output)
    const pluginObserve: SessionObserve = { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
    if (!executor) return pluginObserve
    return mergeObserve(
      pluginObserve,
      yield* executor.runObserve({
        event: "Interrupt",
        matchName: "interrupt",
        sessionID: input.sessionID,
        payload: { reason: "interrupt" },
      }),
    )
  })

  return Service.of({
    runPreToolUse,
    runPermissionRequest,
    runPermissionAsk,
    runPostToolUse,
    runPostToolUseFailure,
    runNotification,
    hasNotification,
    runSessionStart,
    runSessionEnd,
    runSessionPrompt,
    runCompact,
    runSubagentStart,
    runSubagentStop,
    runStop,
    hasStop,
    runIdle,
    runInterrupt,
  })
}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      // In-memory plugin hooks are already-loaded code and therefore trusted.
      // File-based command hooks consult HooksTrust before execution (Task 9);
      // trust lookup failures fail closed via isTrusted === false.
      yield* HooksTrust.Service
      return createRunner(yield* Plugin.Service, yield* HooksExecutor.Service)
    }),
  ),
  deps: [
    // Plugin is declared, not read from whatever context this layer is first
    // built in: the layer is memoized process-wide, so a graph reaching
    // HooksRunner without Plugin would leave every caller with a runner that
    // drops plugin hooks. Lazy because src/plugin transitively imports this
    // module (via session, permission, question, ...).
    LayerNode.lazy(() => Plugin.node),
    HooksTrust.node,
    HooksExecutor.node,
  ],
})

export * as HooksRunner from "./runner"
