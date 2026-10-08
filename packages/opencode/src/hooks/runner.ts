import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Option } from "effect"
import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin } from "@/plugin"
import { HooksExecutor, type ExecutorInterface } from "@/hooks/executor"
import { HooksTrust } from "@/hooks/trust"

export type PreToolUseDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; additionalContext?: string }
  | { behavior: "deny"; message: string }
  | { behavior: "undecided"; additionalContext?: string }

export type PostToolUseOutcome =
  | { blocked: true; reason: string }
  | { blocked: false; additionalContext?: string }

export type SessionObserve = {
  additionalContext?: string
  systemMessage?: string
  continue?: boolean
  stopReason?: string
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
  }) => Effect.Effect<PreToolUseDecision>
  readonly runPermissionRequest: (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
  }) => Effect.Effect<PreToolUseDecision>
  readonly runPostToolUse: (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
    output: string
  }) => Effect.Effect<PostToolUseOutcome>
  readonly runSessionStart: (input: {
    sessionID: string
    source: "startup" | "resume" | "clear" | "compact"
  }) => Effect.Effect<SessionObserve>
  readonly runSessionEnd: (input: { sessionID: string }) => Effect.Effect<void>
  readonly runSessionPrompt: (input: { sessionID: string; prompt: string }) => Effect.Effect<SessionObserve>
  readonly runUserPromptSubmit: (input: { sessionID: string; prompt: string }) => Effect.Effect<SessionObserve>
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
  readonly runSubagentStop: (input: {
    sessionID: string
    agentID: string
    agentType: string
  }) => Effect.Effect<SessionObserve>
  readonly runIdle: (input: { sessionID: string; reason?: "idle" | "interrupt" }) => Effect.Effect<SessionObserve>
  readonly runStop: (input: { sessionID: string }) => Effect.Effect<SessionObserve>
  readonly runInterrupt: (input: { sessionID: string }) => Effect.Effect<SessionObserve>
}

export class Service extends Context.Service<Service, RunnerInterface>()("@opencode/HooksRunner") {}

export function denyWins(decisions: Array<PreToolUseDecision>): PreToolUseDecision {
  const denied = decisions.find((decision) => decision.behavior === "deny")
  if (denied) return denied
  const rewritten = decisions.find((decision) => decision.behavior === "allow" && decision.updatedInput)
  if (rewritten) return rewritten
  const allowed = decisions.find((decision) => decision.behavior === "allow")
  if (allowed) return allowed
  return { behavior: "undecided" }
}

// Surfaces hook systemMessage warnings through logs (the CLI stream transport
// renders log warnings; dedicated TUI surfacing is a follow-up). Failures
// stay advisory: observe hooks never block the lifecycle event they annotate.
export function reportObserve(label: string, self: Effect.Effect<SessionObserve | void>) {
  return self.pipe(
    Effect.tap((out) =>
      out && typeof out === "object" && out.systemMessage
        ? Effect.logWarning(label, { systemMessage: out.systemMessage })
        : Effect.void,
    ),
    Effect.ignore,
  )
}

type TriggerLike = {
  trigger: Plugin.Interface["trigger"]
  triggerDecision: Plugin.Interface["triggerDecision"]
}

type ExecutorLike = Pick<ExecutorInterface, "runDecision" | "runPostTool" | "runObserve">

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
  }
}

export function createRunner(plugin: TriggerLike, executor?: ExecutorLike): RunnerInterface {
  const runPreToolUse = Effect.fn("HooksRunner.runPreToolUse")(function* (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
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
        })
      : undefined
    if (fileVerdict?.behavior === "deny") return fileVerdict
    const fileRewrite = fileVerdict && fileVerdict.behavior === "allow" ? fileVerdict.updatedInput : undefined
    const output = { args: verdict.updatedInput ?? fileRewrite ?? input.args }
    yield* plugin.trigger(
      "tool.execute.before",
      { tool: input.tool, sessionID: input.sessionID, callID: input.callID },
      output,
    )
    if (output.args !== input.args) {
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

  const runPermissionRequest = Effect.fn("HooksRunner.runPermissionRequest")(function* (input: {
    sessionID: string
    tool: string
    callID: string
    args: Record<string, unknown>
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
    output: string
  }) {
    const output = { title: "", output: input.output, metadata: {} }
    yield* plugin.trigger(
      "tool.execute.after",
      { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: input.args },
      output,
    )
    const filePost = executor
      ? yield* executor.runPostTool({
          tool: input.tool,
          matchName: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
          args: input.args,
          output: input.output,
        })
      : undefined
    const pluginBlocked = output.output !== input.output && output.output.startsWith("BLOCKED:")
    if (filePost?.blocked) return filePost
    if (pluginBlocked) return { blocked: true as const, reason: output.output }
    const contexts = [filePost?.additionalContext].filter((part): part is string => part !== undefined)
    if (contexts.length > 0) return { blocked: false as const, additionalContext: contexts.join("\n\n") }
    return { blocked: false as const, additionalContext: undefined }
  })

  const runSessionStart = Effect.fn("HooksRunner.runSessionStart")(function* (input: {
    sessionID: string
    source: "startup" | "resume" | "clear" | "compact"
  }) {
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("session.start", input, output)
    const pluginObserve: SessionObserve = { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
    if (!executor) return pluginObserve
    return mergeObserve(
      pluginObserve,
      yield* executor.runObserve({
        event: "SessionStart",
        matchName: input.source,
        sessionID: input.sessionID,
        payload: { source: input.source },
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

  const runSubagentStop = Effect.fn("HooksRunner.runSubagentStop")(function* (input: {
    sessionID: string
    agentID: string
    agentType: string
  }) {
    const output = {
      additionalContext: undefined as string | undefined,
      systemMessage: undefined as string | undefined,
      continue: undefined as boolean | undefined,
      stopReason: undefined as string | undefined,
    }
    yield* plugin.trigger("subagent.stop", input, output)
    const pluginObserve: SessionObserve = {
      additionalContext: output.additionalContext,
      systemMessage: output.systemMessage,
      continue: output.continue,
      stopReason: output.stopReason,
    }
    if (!executor) return pluginObserve
    return mergeObserve(
      pluginObserve,
      yield* executor.runObserve({
        event: "SubagentStop",
        matchName: input.agentType,
        sessionID: input.sessionID,
        payload: { agentID: input.agentID, agentType: input.agentType },
      }),
    )
  })

  const runIdle = Effect.fn("HooksRunner.runIdle")(function* (input: { sessionID: string; reason?: "idle" | "interrupt" }) {
    const reason = input.reason ?? "idle"
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("session.idle", { sessionID: input.sessionID, reason }, output)
    const pluginObserve: SessionObserve = { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
    if (!executor) return pluginObserve
    return mergeObserve(
      pluginObserve,
      yield* executor.runObserve({
        event: "Stop",
        matchName: reason,
        sessionID: input.sessionID,
        payload: { reason },
      }),
    )
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
    runPostToolUse,
    runSessionStart,
    runSessionEnd,
    runSessionPrompt,
    runUserPromptSubmit: runSessionPrompt,
    runCompact,
    runSubagentStart,
    runSubagentStop,
    runIdle,
    runStop: runIdle,
    runInterrupt,
  })
}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      // Dynamic import: src/plugin/index pulls the full internal plugin graph
      // (which transitively reaches session/prompt -> tool/task -> this module),
      // so a static value import would create an eval-time cycle (TDZ on Plugin.node).
      // serviceOption keeps this layer free of a hard Plugin dependency: graphs
      // that provide Plugin.Service get full hook behavior, others degrade to
      // passthrough with a warning instead of failing layer construction.
      const pluginModule = yield* Effect.promise(() => import("../plugin"))
      const maybePlugin = yield* Effect.serviceOption(pluginModule.Plugin.Service)
      const maybeExecutor = yield* Effect.serviceOption(HooksExecutor.Service)
      const trust = yield* HooksTrust.Service
      // In-memory plugin hooks are already-loaded code and therefore trusted.
      // File-based command hooks consult HooksTrust before execution (Task 9);
      // trust lookup failures fail closed via isTrusted === false.
      void trust
      if (Option.isNone(maybePlugin)) {
        yield* Effect.logWarning("HooksRunner running without Plugin service; hooks disabled")
        return createRunner(noopPlugin, Option.getOrUndefined(maybeExecutor))
      }
      return createRunner(maybePlugin.value, Option.getOrUndefined(maybeExecutor))
    }),
  ),
  deps: [HooksTrust.node, HooksExecutor.node],
})

const noopPlugin: TriggerLike = {
  trigger: (_name, _input, output) => Effect.succeed(output as never),
  triggerDecision: (_input, output) => Effect.succeed(output),
}

function stubPlugin(hooks: Array<Hooks>): TriggerLike {
  return {
    trigger: ((name: string, input: unknown, output: Record<string, unknown>) => {
      return Effect.promise(async () => {
        for (const hook of hooks) {
          const fn = (hook as Record<string, unknown>)[name] as
            | ((input: unknown, output: Record<string, unknown>) => Promise<void>)
            | undefined
          if (!fn) continue
          await fn(input, output)
        }
        return output as never
      })
    }) as TriggerLike["trigger"],
    triggerDecision: (input, output) => {
      // Same aggregation as Plugin.triggerDecision: isolated per-hook
      // outputs, deny wins with short-circuit, allows merge updatedInput.
      return Effect.promise(async () => {
        const mergedUpdated: Record<string, unknown> = {}
        let sawRewrite = false
        for (const hook of hooks) {
          const fn = hook["tool.permission"]
          if (!fn) continue
          const perHook: { decision: "allow" | "deny" | "undecided"; message?: string; updatedInput?: Record<string, unknown> } = {
            decision: "undecided",
          }
          await fn(input, perHook)
          if (perHook.decision === "deny") {
            output.decision = "deny"
            output.message = perHook.message
            return output
          }
          if (perHook.decision !== "allow") continue
          output.decision = "allow"
          if (perHook.updatedInput) {
            sawRewrite = true
            Object.assign(mergedUpdated, perHook.updatedInput)
          }
        }
        if (sawRewrite) output.updatedInput = mergedUpdated
        return output
      })
    },
  }
}

export function testLayerWithHooks(hooks: Array<Hooks>, executor?: ExecutorLike) {
  return Layer.succeed(Service, createRunner(stubPlugin(hooks), executor))
}

function defaultTestHooks(): Array<Hooks> {
  return [
    {
      "tool.execute.before": async (_input, output) => {
        const args = output.args as Record<string, unknown>
        if (args["command"] === "ls") output.args = { command: "ls --safe" }
      },
      "tool.permission": async (input, output) => {
        const args = input.args as Record<string, unknown>
        const haystack = JSON.stringify(args)
        if (haystack.includes("rm -rf")) {
          output.decision = "deny"
          output.message = "Denied by hook"
          return
        }
        if (haystack.includes("echo hi")) {
          output.decision = "allow"
          return
        }
      },
      "session.start": async (_input, output) => {
        output.additionalContext = "workspace conventions"
      },
    } satisfies Hooks,
    {
      "tool.permission": async (input, output) => {
        const args = input.args as Record<string, unknown>
        if (JSON.stringify(args).includes("rm -rf")) {
          output.decision = "deny"
          output.message = "Denied by hook"
        }
      },
    } satisfies Hooks,
  ]
}

export const testLayer = Layer.succeed(Service, createRunner(stubPlugin(defaultTestHooks())))

export * as HooksRunner from "./runner"
