import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Project } from "@/project/project"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { AutoReviewer } from "@/permission/auto-reviewer"
import { Sandbox } from "@/permission/sandbox"
import { Reviewer } from "@/permission/reviewer"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { HooksRunner } from "@/hooks/runner"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect, Option } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { isRecord } from "@/util/record"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceRef } from "@/effect/instance-ref"

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const hooksRunner = yield* HooksRunner.Service
  const permission = yield* Permission.Service
  const config = yield* Config.Service
  const project = yield* Project.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const flags = yield* RuntimeFlags.Service
  // Optional so minimal environments fail open: no reviewer service defers to
  // the human prompt under approval "auto".
  const autoReviewer = yield* Effect.serviceOption(AutoReviewer.Service)

  const cfg = yield* config.get()
  const policy = ConfigPermissionV1.resolveSessionPolicy(cfg.permission ?? {})
  // Write containment is session-scoped: project sandboxes plus this session's
  // own attached additional directories (InstanceRef). Deliberately not the
  // cross-session SessionFolders union — a session must not inherit another
  // session's extras.
  const instanceDirs = (yield* InstanceRef)?.additionalDirectories ?? []
  const sandboxDirs = yield* project
    .sandboxes(input.session.projectID)
    .pipe(
      Effect.map((dirs) => [...dirs, ...instanceDirs]),
      Effect.catch(() => Effect.succeed(instanceDirs)),
    )

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions, toolID: string): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: match.state.status === "running" ? match.state.time : { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      Effect.gen(function* () {
        const ruleset = Permission.merge(input.agent.permission, input.session.permission ?? [])
        // Bash patterns are command globs, not paths; the shell tool raises external_directory
        // for paths it touches, so bash itself is only gated by readonly.
        if (req.permission === "bash" && policy.sandbox === "readonly") {
          return yield* Effect.orDie(
            Effect.fail(new Sandbox.SandboxViolationError({ path: input.session.directory, level: policy.sandbox })),
          )
        }
        // The sandbox contains writes only: reads (read/glob/grep/list/lsp/skill,
        // Truncate output) may cross the workspace boundary through the normal
        // external_directory prompt.
        if (Sandbox.containsWrite({ permission: req.permission, toolID })) {
          const blocked = req.patterns.find(
            (target) =>
              target !== "" && !Sandbox.isPathAllowed(target, input.session.directory, sandboxDirs, policy.sandbox),
          )
          if (blocked !== undefined) {
            return yield* Effect.orDie(
              Effect.fail(new Sandbox.SandboxViolationError({ path: blocked, level: policy.sandbox })),
            )
          }
        }
        if (
          Reviewer.review({ permission: req.permission, patterns: req.patterns, ruleset, tool: toolID, args }) ===
          "allow"
        ) {
          return
        }
        // approval "auto": the LLM auto-reviewer vets the request before the
        // human prompt. allow approves without prompting, deny fails closed,
        // defer or an absent reviewer service falls through to the normal
        // prompt path. The verdict rides on the ask input so the
        // permission.asked event can surface it to the dock.
        const reviewer =
          policy.approval === "auto" && !Permission.ALWAYS_ASK.includes(req.permission)
            ? Option.isSome(autoReviewer)
              ? yield* autoReviewer.value.request({
                  sessionID: input.session.id,
                  tool: toolID,
                  args,
                  permission: req.permission,
                  patterns: req.patterns,
                })
              : "defer"
            : undefined
        if (reviewer === "deny") {
          return yield* Effect.orDie(
            Effect.fail(
              new PermissionV1.DeniedError({
                ruleset: ruleset.filter((rule) => Wildcard.match(req.permission, rule.permission)),
              }),
            ),
          )
        }
        return yield* permission
          .ask({
            ...req,
            sessionID: input.session.id,
            tool: { messageID: input.processor.message.id, callID: options.toolCallId },
            ruleset,
            approval: policy.approval,
            ...(reviewer !== undefined ? { reviewer } : {}),
            hook: { tool: toolID, args },
          })
          .pipe(Effect.orDie)
      }),
  })

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options, item.id)
            const decision = yield* hooksRunner.runPreToolUse({
              sessionID: ctx.sessionID,
              tool: item.id,
              callID: options.toolCallId ?? ctx.callID ?? "unknown",
              args: toRecord(args),
            })
            if (decision.behavior === "deny") throw new HooksRunner.HookDeniedError(decision.message)
            const resolved = resolveEffectiveArgs(item.id, args, decision)
            if (resolved.warning) yield* Effect.logWarning(resolved.warning, { toolID: item.id })
            const effectiveArgs = resolved.effective
            const result = yield* item.execute(effectiveArgs, ctx)
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            const post = yield* hooksRunner.runPostToolUse({
              sessionID: ctx.sessionID,
              tool: item.id,
              callID: options.toolCallId ?? ctx.callID ?? "unknown",
              args: toRecord(effectiveArgs),
              result: output,
            })
            const finalOutput = { ...output, ...post }
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, finalOutput)
            }
            return finalOutput
          }),
        )
      },
    })
  }

  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) {
    tools[MCP_RESOURCE_TOOLS.list] = tool({
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Optional MCP server name. When omitted, lists resources from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts, MCP_RESOURCE_TOOLS.list)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            const preList = yield* hooksRunner.runPreToolUse({
              sessionID: ctx.sessionID,
              tool: MCP_RESOURCE_TOOLS.list,
              callID: opts.toolCallId,
              args: toRecord(args),
            })
            if (preList.behavior === "deny") throw new HooksRunner.HookDeniedError(preList.message)
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const resources = Object.values(yield* mcp.resources(parsed.server))
            const filtered = resources
              .filter((resource) => !parsed.server || resource.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uri,
                ),
              )
            const content = JSON.stringify({ resources: filtered.map(formatMcpResource) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            const postList = yield* hooksRunner.runPostToolUse({
              sessionID: ctx.sessionID,
              tool: MCP_RESOURCE_TOOLS.list,
              callID: opts.toolCallId,
              args: toRecord(args),
              result: output,
            })
            const finalList = { ...output, ...postList }
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, finalList)
            }
            return finalList
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.listTemplates] = tool({
      description:
        "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description:
                "Optional MCP server name. When omitted, lists resource templates from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts, MCP_RESOURCE_TOOLS.listTemplates)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            const preTemplates = yield* hooksRunner.runPreToolUse({
              sessionID: ctx.sessionID,
              tool: MCP_RESOURCE_TOOLS.listTemplates,
              callID: opts.toolCallId,
              args: toRecord(args),
            })
            if (preTemplates.behavior === "deny") throw new HooksRunner.HookDeniedError(preTemplates.message)
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const templates = Object.values(yield* mcp.resourceTemplates(parsed.server))
            const filtered = templates
              .filter((template) => !parsed.server || template.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate,
                ),
              )
            const content = JSON.stringify({ resourceTemplates: filtered.map(formatMcpResourceTemplate) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resource templates: ${parsed.server}` : "MCP resource templates",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            const postTemplates = yield* hooksRunner.runPostToolUse({
              sessionID: ctx.sessionID,
              tool: MCP_RESOURCE_TOOLS.listTemplates,
              callID: opts.toolCallId,
              args: toRecord(args),
              result: output,
            })
            const finalTemplates = { ...output, ...postTemplates }
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, finalTemplates)
            }
            return finalTemplates
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.read] = tool({
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "MCP server name exactly as returned by list_mcp_resources.",
            },
            uri: {
              type: "string",
              description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
            },
          },
          required: ["server", "uri"],
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseReadMcpResourceArgs(args)
            const ctx = context(toRecord(args), opts, MCP_RESOURCE_TOOLS.read)
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              throw new Error(`MCP server "${parsed.server}" is not connected`)
            }
            if (!client.getServerCapabilities()?.resources) {
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            }
            const preRead = yield* hooksRunner.runPreToolUse({
              sessionID: ctx.sessionID,
              tool: MCP_RESOURCE_TOOLS.read,
              callID: opts.toolCallId,
              args: toRecord(args),
            })
            if (preRead.behavior === "deny") throw new HooksRunner.HookDeniedError(preRead.message)
            yield* ctx.ask({
              permission: "read",
              metadata: { server: parsed.server, uri: parsed.uri },
              patterns: [`mcp:${parsed.server}:${parsed.uri}`],
              always: [`mcp:${parsed.server}:*`],
            })

            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)

            const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
            const truncated = yield* truncate.output(formatted.text, {}, input.agent)
            const output = {
              title: `MCP resource: ${parsed.uri}`,
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: formatted.attachments.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
              attachments: formatted.attachments.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            const postRead = yield* hooksRunner.runPostToolUse({
              sessionID: ctx.sessionID,
              tool: MCP_RESOURCE_TOOLS.read,
              callID: opts.toolCallId,
              args: toRecord(args),
              result: output,
            })
            const finalRead = { ...output, ...postRead }
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, finalRead)
            }
            return finalRead
          }),
        )
      },
    })
  }

  if (flags.experimentalCodeMode) return tools

  for (const [key, entry] of Object.entries(yield* mcp.tools())) {
    const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout)
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts, key)
          const preMcp = yield* hooksRunner.runPreToolUse({
            sessionID: ctx.sessionID,
            tool: key,
            callID: opts.toolCallId,
            args: toRecord(args),
          })
          if (preMcp.behavior === "deny") throw new HooksRunner.HookDeniedError(preMcp.message)
          const resolvedMcp = resolveEffectiveArgs(key, args, preMcp)
          if (resolvedMcp.warning) yield* Effect.logWarning(resolvedMcp.warning, { toolID: key })
          const effectiveMcp = resolvedMcp.effective
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(effectiveMcp, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          // PostToolUse observe + block-replace runs on the truncated
          // model-visible output below via runPostToolUse.

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                const mime = resource.mimeType ?? "application/octet-stream"
                const size = base64Size(resource.blob)
                if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
                  )
                  continue
                }
                if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                  )
                  continue
                }
                attachments.push({
                  type: "file",
                  mime,
                  url: `data:${mime};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          const postMcp = yield* hooksRunner.runPostToolUse({
            sessionID: ctx.sessionID,
            tool: key,
            callID: opts.toolCallId,
            args: toRecord(effectiveMcp),
            result: output,
          })
          const finalMcp = { ...output, ...postMcp }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, finalMcp)
          }
          return finalMcp
        }),
      )
    tools[key] = item
  }

  return tools
})

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

// Pure: malformed rewrites fall back to the original args and report a
// warning the caller yields into the stream transport (never forked here).
export function resolveEffectiveArgs(
  toolID: string,
  original: unknown,
  decision: HooksRunner.PreToolUseDecision,
): { effective: unknown; warning?: string } {
  if (decision.behavior !== "allow" || !decision.updatedInput) return { effective: original }
  const updated = decision.updatedInput
  if (toolID === "bash" && "command" in updated && typeof updated["command"] !== "string") {
    return { effective: original, warning: "hook rewrite rejected: bash command must be a string" }
  }
  if (toolID === "apply_patch" && "patchText" in updated && typeof updated["patchText"] !== "string") {
    return { effective: original, warning: "hook rewrite rejected: apply_patch patchText must be a string" }
  }
  return { effective: updated }
}

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return { server: optionalString(args, "server") }
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") }
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function formatMcpResourceTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter((entry) => entry[0] !== "client"))
  return { ...result, server: template.client }
}

function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"
