import { ToolFailure } from "@opencode-ai/llm"
import type { Hooks, ToolContext } from "@opencode-ai/plugin"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { PermissionV2, type Interface as PermissionInterface } from "@opencode-ai/core/permission"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { EffectBridge } from "@/effect/bridge"
import { Effect, Option, Schema } from "effect"

// The tool executes inside a location runtime where PermissionV2 is provided;
// look it up dynamically so this module does not add a static layer edge.
function PermissionLookup(_sessionID: string): Effect.Effect<PermissionInterface | undefined> {
  return Effect.map(Effect.serviceOption(PermissionV2.Service), Option.getOrUndefined)
}

// V1 plugin tools are process-global registry groups keyed per directory so
// two instances in one server process cannot overwrite each other's tools.
const group = (directory: string) => `v1-plugin:${directory}`

export function syncPluginTools(hooks: readonly Hooks[], directory: string, worktree: string) {
  const tools: Record<string, Tool.AnyTool> = {}
  for (const hook of hooks) {
    for (const [name, definition] of Object.entries(hook.tool ?? {})) {
      const fields = Object.keys(definition.args ?? {})
      tools[name] = Tool.make({
        description: fields.length
          ? `${definition.description}\nArguments: ${fields.join(", ")}`
          : definition.description,
        input: Schema.Unknown,
        output: Schema.String,
        execute: (input, context) =>
          Effect.gen(function* () {
            const bridge = yield* EffectBridge.make()
            return yield* Effect.tryPromise({
              // The try callback's signal aborts when the tool fiber is
              // interrupted (session cancel), matching the interrupted-tool
              // settlement in the runner.
              try: (signal) => {
                const result = definition.execute(
                  input as never,
                  pluginContext(context, directory, worktree, signal, bridge),
                )
                return typeof result === "string" ? result : result.then((r) => (typeof r === "string" ? r : r.output))
              },
              catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
            })
          }),
      })
    }
  }
  ToolRegistry.replaceGroup(group(directory), tools)
}

export function clearPluginTools(directory: string) {
  ToolRegistry.clearGroup(group(directory))
}

export function pluginContext(
  context: { sessionID: string; assistantMessageID: string; agent: string },
  directory: string,
  worktree: string,
  signal: AbortSignal,
  bridge: EffectBridge.Shape,
): ToolContext {
  return {
    sessionID: context.sessionID,
    messageID: context.assistantMessageID,
    agent: context.agent,
    directory,
    worktree,
    abort: signal,
    metadata() {
      // Plugin metadata streaming is v1-loop only; the v2 runner publishes
      // tool state itself.
    },
    ask: (request) =>
      bridge.promise(
        // Route plugin permission requests through the Permission service so
        // configured rules apply on this path too; a denial rejects the
        // promise and surfaces as a ToolFailure.
        Effect.flatMap(PermissionLookup(context.sessionID), (permission) => {
          if (!permission) return Effect.void
          return permission
            .ask({
              action: request.permission,
              resources: request.patterns,
              save: request.always,
              metadata: request.metadata,
              sessionID: SessionSchema.ID.make(context.sessionID),
              agent: AgentV2.ID.make(context.agent),
              source: { type: "tool", messageID: context.assistantMessageID, callID: "" },
            })
            .pipe(Effect.asVoid)
        }),
      ),
  }
}