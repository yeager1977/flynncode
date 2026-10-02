import { ToolFailure } from "@opencode-ai/llm"
import type { Hooks, ToolContext } from "@opencode-ai/plugin"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Effect, Schema } from "effect"

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
          Effect.tryPromise({
            try: async () => {
              const result = await definition.execute(input as never, pluginContext(context, directory, worktree))
              return typeof result === "string" ? result : result.output
            },
            catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
          }),
      })
    }
  }
  ToolRegistry.replaceGroup(group(directory), tools)
}

export function clearPluginTools(directory: string) {
  ToolRegistry.clearGroup(group(directory))
}

function pluginContext(
  context: { sessionID: string; assistantMessageID: string; agent: string },
  directory: string,
  worktree: string,
): ToolContext {
  return {
    sessionID: context.sessionID,
    messageID: context.assistantMessageID,
    agent: context.agent,
    directory,
    worktree,
    abort: AbortSignal.timeout(120_000),
    metadata() {},
    ask: async () => {},
  }
}
