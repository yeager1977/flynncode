import { ToolFailure } from "@opencode-ai/llm"
import type { Hooks, ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { PermissionV2, type Interface as PermissionInterface } from "@opencode-ai/core/permission"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { EffectBridge } from "@/effect/bridge"
import { Effect, JsonSchema, Option, Schema, SchemaRepresentation } from "effect"
import z from "zod"

// The tool executes inside a location runtime where PermissionV2 is provided;
// look it up dynamically so this module does not add a static layer edge.
function PermissionLookup(_sessionID: string): Effect.Effect<PermissionInterface | undefined> {
  return Effect.map(Effect.serviceOption(PermissionV2.Service), Option.getOrUndefined)
}

// V1 plugin tools are process-global registry groups keyed per directory so
// two instances in one server process cannot overwrite each other's tools, and
// scoped to that directory so they only materialize for its own Location.
const group = (directory: string) => `v1-plugin:${directory}`

export function syncPluginTools(hooks: readonly Hooks[], directory: string, worktree: string) {
  const tools = Object.fromEntries(
    hooks.flatMap((hook) =>
      Object.entries(hook.tool ?? {}).map(([name, definition]) => [name, fromPlugin(definition, directory, worktree)]),
    ),
  )
  ToolRegistry.replaceGroup(group(directory), tools, directory)
}

export function clearPluginTools(directory: string) {
  ToolRegistry.clearGroup(group(directory))
}

// Mirrors the v1 registry's fromPlugin: Zod args give the model their JSON
// Schema and are validated with safeParse before the plugin runs; legacy
// JSON-Schema args are advertised as-is. Output bounding happens centrally in
// ToolRegistry settlement (ToolOutputStore), matching v1 truncation limits.
function fromPlugin(definition: ToolDefinition, directory: string, worktree: string) {
  const entries = Object.entries(definition.args ?? {})
  const zod = entries.every((entry) => isZodType(entry[1])) ? z.object(definition.args ?? {}) : undefined
  return Tool.make({
    description: definition.description,
    input: inputSchema(zod ? z.toJSONSchema(zod, { io: "input" }) : legacyJsonSchema(entries)),
    output: Schema.String,
    execute: (input, context) =>
      Effect.gen(function* () {
        const parsed = zod?.safeParse(input)
        if (parsed && !parsed.success)
          return yield* new ToolFailure({ message: `Invalid tool input: ${z.prettifyError(parsed.error)}` })
        const args = parsed ? parsed.data : input
        const bridge = yield* EffectBridge.make()
        return yield* Effect.tryPromise({
          // The try callback's signal aborts when the tool fiber is
          // interrupted (session cancel), matching the interrupted-tool
          // settlement in the runner.
          try: (signal) => {
            const result = definition.execute(args as never, pluginContext(context, directory, worktree, signal, bridge))
            return Promise.resolve(result).then((r) => (typeof r === "string" ? r : r.output))
          },
          catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
        })
      }),
  })
}

// Core tools derive their advertised JSON Schema from an Effect Schema, so
// rebuild one from the plugin's JSON Schema. Zod stays the authoritative
// validator inside execute.
function inputSchema(json: unknown) {
  if (!isRecord(json)) return Schema.Unknown
  const { $schema, ...schema } = json
  // The converter throws on JSON Schema it cannot represent; advertise an
  // untyped input then rather than failing every tool of the plugin.
  try {
    return SchemaRepresentation.toSchema<Tool.SchemaType<unknown>>(
      SchemaRepresentation.fromJsonSchemaDocument({
        dialect: "draft-2020-12",
        schema,
        // Zod emits $defs from its own JSON Schema generator; trust its shape.
        definitions: isRecord(schema.$defs) ? (schema.$defs as JsonSchema.Definitions) : {},
      }),
    )
  } catch {
    return Schema.Unknown
  }
}

function legacyJsonSchema(entries: [string, unknown][]) {
  const properties = Object.fromEntries(entries.filter((entry) => typeof entry[1] === "boolean" || isRecord(entry[1])))
  return { type: "object", properties, required: Object.keys(properties) }
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function pluginContext(
  context: { sessionID: string; assistantMessageID: string; agent: string; toolCallID: string },
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
        // promise and surfaces as a ToolFailure. Without the service there is
        // nothing to enforce rules, so fail closed rather than allow.
        Effect.flatMap(PermissionLookup(context.sessionID), (permission) => {
          if (!permission)
            return Effect.fail(new Error(`permission "${request.permission}" cannot be checked outside a session location`))
          return permission
            .ask({
              action: request.permission,
              resources: request.patterns,
              save: request.always,
              metadata: request.metadata,
              sessionID: SessionSchema.ID.make(context.sessionID),
              agent: AgentV2.ID.make(context.agent),
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            .pipe(Effect.asVoid)
        }),
      ),
  }
}
