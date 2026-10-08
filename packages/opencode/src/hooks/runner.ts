import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Option } from "effect"
import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin } from "@/plugin"
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
  readonly runIdle: (input: { sessionID: string }) => Effect.Effect<SessionObserve>
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

export function createRunner(plugin: TriggerLike): RunnerInterface {
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
    const output = { args: verdict.updatedInput ?? input.args }
    yield* plugin.trigger(
      "tool.execute.before",
      { tool: input.tool, sessionID: input.sessionID, callID: input.callID },
      output,
    )
    if (output.args !== input.args) return { behavior: "allow", updatedInput: output.args } as const
    if (verdict.decision === "allow") {
      if (verdict.updatedInput) return { behavior: "allow", updatedInput: verdict.updatedInput } as const
      return { behavior: "allow" } as const
    }
    return { behavior: "undecided" } as const
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
    // Fail closed on malformed hook output: unknown decision shapes fall through
    // as undecided only when explicitly undecided; deny always wins.
    if (output.decision === "deny") return { behavior: "deny", message: output.message ?? "Denied by hook" } as const
    if (output.decision === "allow" && output.updatedInput)
      return { behavior: "allow", updatedInput: output.updatedInput } as const
    if (output.decision === "allow") return { behavior: "allow" } as const
    return { behavior: "undecided" } as const
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
    const blocked = output.output !== input.output && output.output.startsWith("BLOCKED:")
    if (blocked) return { blocked: true as const, reason: output.output }
    return { blocked: false as const, additionalContext: undefined }
  })

  const runSessionStart = Effect.fn("HooksRunner.runSessionStart")(function* (input: {
    sessionID: string
    source: "startup" | "resume" | "clear" | "compact"
  }) {
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("session.start", input, output)
    return { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
  })

  const runSessionEnd = Effect.fn("HooksRunner.runSessionEnd")(function* (input: { sessionID: string }) {
    // Advisory only: SessionEnd output never steers.
    yield* plugin.trigger(
      "session.end",
      { sessionID: input.sessionID, reason: "other" as const },
      { systemMessage: undefined as string | undefined },
    )
  })

  const runSessionPrompt = Effect.fn("HooksRunner.runSessionPrompt")(function* (input: {
    sessionID: string
    prompt: string
  }) {
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("session.prompt", input, output)
    return { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
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
    return { additionalContext: output.additionalContext, systemMessage: output.systemMessage, continue: output.continue }
  })

  const runSubagentStart = Effect.fn("HooksRunner.runSubagentStart")(function* (input: {
    sessionID: string
    agentID: string
    agentType: string
  }) {
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("subagent.start", input, output)
    // continue:false on SubagentStart is parsed but ignored per trust model.
    return { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
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
    return {
      additionalContext: output.additionalContext,
      systemMessage: output.systemMessage,
      continue: output.continue,
      stopReason: output.stopReason,
    }
  })

  const runIdle = Effect.fn("HooksRunner.runIdle")(function* (input: { sessionID: string }) {
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("session.idle", input, output)
    return { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
  })

  const runInterrupt = Effect.fn("HooksRunner.runInterrupt")(function* (input: { sessionID: string }) {
    // Reuses the existing user-interrupt path: advisory observe hook only,
    // no parallel interruption mechanism.
    const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
    yield* plugin.trigger("session.idle", input, output)
    return { additionalContext: output.additionalContext, systemMessage: output.systemMessage }
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
      const trust = yield* HooksTrust.Service
      // In-memory plugin hooks are already-loaded code and therefore trusted.
      // File-based command hooks consult HooksTrust before execution (Task 9);
      // trust lookup failures fail closed via isTrusted === false.
      void trust
      if (Option.isNone(maybePlugin)) {
        yield* Effect.logWarning("HooksRunner running without Plugin service; hooks disabled")
        return createRunner(noopPlugin)
      }
      return createRunner(maybePlugin.value)
    }),
  ),
  deps: [HooksTrust.node],
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

export function testLayerWithHooks(hooks: Array<Hooks>) {
  return Layer.succeed(Service, createRunner(stubPlugin(hooks)))
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
