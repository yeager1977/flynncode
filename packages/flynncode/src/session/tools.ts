import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Project } from "@/project/project"
import { ConfigPermissionV1 } from "@flynncode/core/v1/config/permission"
import { SessionV1 } from "@flynncode/core/v1/session"
import { PermissionV1 } from "@flynncode/core/v1/permission"
import { Wildcard } from "@flynncode/core/util/wildcard"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { McpDefer } from "@/mcp/defer"
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
import { Cause, Effect, Option } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { isRecord } from "@/util/record"
import { errorMessage } from "@/util/error"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionWorkspace } from "./workspace"

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
// Built-in tools whose own permission check always asks under their permission
// key (Permission.toolPermission) before they act, so a PreToolUse ask forces
// that check instead of adding a prompt. bash checks every non-blank command
// under a hook ask (`hookAsk` in the context's extra). MCP tools check their key
// too. A custom or plugin tool reusing one of these ids is not covered: its
// checks are unknown, so it gets the separate prompt before it runs.
const SELF_GATED = new Set([
  "bash",
  "edit",
  "write",
  "multiedit",
  "notebook_edit",
  "apply_patch",
  "read",
  "glob",
  "grep",
  "lsp",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
  "message",
])
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
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall" | "stopAfterStep">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  // Rules the user message being answered grants to this turn only.
  turnPermission?: PermissionV1.Ruleset
  // The step's MCP deferral plan (see mcpPlan).
  mcp: McpPlan
  // tool_search over the plan's deferral-eligible tools, built by the caller while deferral is active.
  toolSearch?: Tool.Def
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
  const global = ConfigPermissionV1.resolveSessionPolicy(cfg.permission ?? {})
  // Sandbox precedence: session metadata (task-dispatched children) beats the
  // agent config, which beats the global policy. Only literal SandboxMode
  // values compete here — named profiles like "restricted" confine through
  // the permission ruleset instead, and unknown values degrade to global.
  const agentSandbox = cfg.agent?.[input.agent.name]?.sandbox
  const metadataSandbox = input.session.metadata?.sandbox
  const policy = {
    ...global,
    sandbox: ConfigPermissionV1.isSandboxMode(metadataSandbox)
      ? metadataSandbox
      : ConfigPermissionV1.isSandboxMode(agentSandbox)
        ? agentSandbox
        : global.sandbox,
  }
  // Additive hook payload context: the model id and policy approval value
  // this turn runs under.
  const hookContext = {
    model: `${input.model.providerID}/${input.model.id}`,
    permissionMode: policy.approval,
  }
  // Write containment is session-scoped: project sandboxes plus this session's
  // own attached additional directories. Deliberately not the
  // cross-session SessionFolders union — a session must not inherit another
  // session's extras.
  const instanceDirs = [...(yield* SessionWorkspace.Directories)]
  const sandboxDirs = yield* project
    .sandboxes(input.session.projectID)
    .pipe(
      Effect.map((dirs) => [...dirs, ...instanceDirs]),
      Effect.catch(() => Effect.succeed(instanceDirs)),
    )

  const context = (
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
    toolID: string,
    confirm?: Confirm,
  ): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: {
      model: input.model,
      bypassAgentCheck: input.bypassAgentCheck,
      promptOps: input.promptOps,
      ...(confirm !== undefined && { hookAsk: true }),
    },
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
          // Memory consent is scope-keyed, while containment must check its
          // actual sanitized destination. Consent never confers path authority.
          const targets = req.permission === "memory"
            ? [typeof req.metadata.filepath === "string" ? req.metadata.filepath : ""]
            : req.patterns
          const blocked = targets.find(
            (target) =>
              (req.permission === "memory" && target === "") ||
              (target !== "" && !Sandbox.isPathAllowed(target, input.session.directory, sandboxDirs, policy.sandbox)),
          )
          if (blocked !== undefined) {
            return yield* Effect.orDie(
              Effect.fail(new Sandbox.SandboxViolationError({ path: blocked, level: policy.sandbox })),
            )
          }
        }
        // The call's first check under the confirmed permission is its single
        // forced prompt, carrying the hook's reason.
        if (confirm?.pending && req.permission === confirm.permission) {
          confirm.pending = false
          return yield* gate({
            req: confirm.reason === undefined ? req : { ...req, metadata: { ...req.metadata, reason: confirm.reason } },
            args,
            toolID,
            callID: options.toolCallId,
            force: true,
          })
        }
        return yield* gate({ req, args, toolID, callID: options.toolCallId, force: false })
      }),
  })

  // `force` is a PreToolUse ask: the request prompts even where a rule or an
  // "always" approval allows it, and the static read approval and
  // accept-edits never skip it. Under approval "auto" the auto-reviewer still
  // answers it, as it answers every prompt in that mode. `ruleset` replaces
  // the session's rules.
  const gate = Effect.fn("SessionTools.gate")(function* (gated: {
    req: Parameters<Tool.Context["ask"]>[0]
    args: Record<string, unknown>
    toolID: string
    callID: string
    force: boolean
    ruleset?: PermissionV1.Ruleset
  }) {
    const req = gated.req
    const ruleset =
      gated.ruleset ??
      Permission.withTurn(
        Permission.merge(input.agent.permission, input.session.permission ?? []),
        input.turnPermission,
        req,
      )
    // Rule-allowed, "always"-approved and denied calls never reach the
    // prompt, so the reviewer only vets requests that would actually ask.
    const asks =
      gated.force ||
      (yield* permission.wouldAsk({
        permission: req.permission,
        patterns: req.patterns,
        ruleset,
        sessionID: input.session.id,
      }))
    const staticApproval = gated.force
      ? "defer"
      : Reviewer.review({
          permission: req.permission,
          patterns: req.patterns,
          ruleset,
          tool: gated.toolID,
          args: gated.args,
        })
    // approval "auto": the LLM auto-reviewer vets the request before the
    // human prompt. allow approves without prompting, deny fails closed,
    // defer or an absent reviewer service falls through to the normal
    // prompt path. The verdict rides on the ask input so the
    // permission.asked event can surface it to the dock.
    const reviewer =
      asks &&
      staticApproval !== "allow" &&
      policy.approval === "auto" &&
      !Permission.ALWAYS_ASK.includes(req.permission)
        ? Option.isSome(autoReviewer)
          ? yield* autoReviewer.value.request({
              sessionID: input.session.id,
              tool: gated.toolID,
              args: gated.args,
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
        tool: { messageID: input.processor.message.id, callID: gated.callID },
        ruleset,
        approval: policy.approval,
        ...(staticApproval === "allow" ? { staticApproval } : {}),
        ...(reviewer !== undefined ? { reviewer } : {}),
        ...(gated.force ? { force: true } : {}),
        hook: { tool: gated.toolID, args: gated.args, stop: input.processor.stopAfterStep },
      })
      .pipe(Effect.orDie)
  })

  // A PreToolUse deny fails the call, and a deny from `continue: false` also
  // ends the turn after this step. An ask means the call must be confirmed
  // with exactly one prompt. A tool with a check of its own (`gatedBy`, its
  // permission key) gets a Confirm for its context, which forces that check
  // to prompt with the tool's own patterns. Any other tool is never gated by
  // the rules, so it gets its one prompt here, before it runs.
  const decide = Effect.fn("SessionTools.decide")(function* (decided: {
    toolID: string
    callID: string
    decision: HooksRunner.PreToolUseDecision
    args: Record<string, unknown>
    gatedBy: string | undefined
  }) {
    const decision = decided.decision
    if (decision.behavior === "deny" && decision.stop) yield* input.processor.stopAfterStep
    if (decision.behavior === "deny") throw new HooksRunner.HookDeniedError(decision.message)
    if (decision.behavior !== "ask") return undefined
    if (decided.gatedBy !== undefined) {
      return { permission: decided.gatedBy, reason: decision.message, pending: true } satisfies Confirm
    }
    yield* gate({
      req: {
        permission: Permission.toolPermission(decided.toolID),
        patterns: ["*"],
        always: [],
        metadata: { input: decided.args, ...(decision.message !== undefined && { reason: decision.message }) },
      },
      args: decided.args,
      toolID: decided.toolID,
      callID: decided.callID,
      force: true,
      ruleset: [],
    })
    return undefined
  })

  // PreToolUse, then the call's context. The context carries the effective
  // input, so auto-review, PermissionRequest hooks and the tool's own
  // permission checks all see a hook's rewrite rather than the model's input.
  const preTool = Effect.fn("SessionTools.preTool")(function* (
    toolID: string,
    args: unknown,
    options: ToolExecutionOptions,
    gatedBy: string | undefined,
  ) {
    const decision = yield* hooksRunner.runPreToolUse({
      ...hookContext,
      sessionID: input.session.id,
      tool: toolID,
      callID: options.toolCallId,
      args: toRecord(args),
    })
    const resolved = resolveEffectiveArgs(toolID, args, decision)
    if (resolved.warning) yield* Effect.logWarning(resolved.warning, { toolID })
    const effective = toRecord(resolved.effective)
    const confirm = yield* decide({ toolID, callID: options.toolCallId, decision, args: effective, gatedBy })
    return { args: resolved.effective, ctx: context(effective, options, toolID, confirm) }
  })

  // PostToolUse when the call succeeded. PostToolUseFailure instead when the
  // tool failed or was aborted; its block reason or context reaches the model
  // after the error, on an error of the same type and fields (the processor
  // stops the turn on permission and question rejections). An interrupted
  // call shows the model nothing, so the note is logged.
  const postTool = <T extends HooksRunner.ToolResultView, E>(
    call: { toolID: string; args: unknown; options: ToolExecutionOptions },
    body: Effect.Effect<T, E>,
  ) =>
    Effect.gen(function* () {
      const failed = (error: string, interrupted: boolean) =>
        hooksRunner.runPostToolUseFailure({
          ...hookContext,
          sessionID: input.session.id,
          tool: call.toolID,
          callID: call.options.toolCallId,
          args: toRecord(call.args),
          error,
          interrupted,
        })
      const output = yield* body.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = Cause.squash(cause)
            const outcome = yield* failed(errorMessage(error), call.options.abortSignal?.aborted === true)
            if (outcome.blocked && outcome.stop) yield* input.processor.stopAfterStep
            const note = outcome.blocked ? outcome.reason : outcome.additionalContext
            if (note === undefined) return yield* Effect.failCause(cause)
            if (Cause.hasInterruptsOnly(cause)) {
              yield* Effect.logWarning("PostToolUseFailure note dropped: the call was interrupted", {
                tool: call.toolID,
                note,
              })
              return yield* Effect.failCause(cause)
            }
            if (!(error instanceof Error)) {
              return yield* Effect.die(new Error(`${errorMessage(error)}\n\n${note}`, { cause: error }))
            }
            if (Cause.hasFails(cause)) {
              return yield* Effect.failCause(Cause.map(cause, (item) => (item === error ? withNote(item, note) : item)))
            }
            return yield* Effect.die(withNote(error, note))
          }),
        ),
      )
      if (call.options.abortSignal?.aborted) {
        yield* failed("Tool execution aborted", true)
        yield* input.processor.completeToolCall(call.options.toolCallId, output)
        return output
      }
      const post = yield* hooksRunner.runPostToolUse({
        ...hookContext,
        sessionID: input.session.id,
        tool: call.toolID,
        callID: call.options.toolCallId,
        args: toRecord(call.args),
        result: output,
      })
      if (post.stop) yield* input.processor.stopAfterStep
      return { ...output, title: post.title, output: post.output, metadata: post.metadata }
    })

  const registered = (item: Tool.Def): AITool => {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    return tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const pre = yield* preTool(
              item.id,
              args,
              options,
              item.builtin && SELF_GATED.has(item.id) ? Permission.toolPermission(item.id) : undefined,
            )
            return yield* postTool(
              { toolID: item.id, args: pre.args, options },
              item.execute(pre.args, pre.ctx).pipe(
                Effect.map((result) => ({
                  ...result,
                  attachments: result.attachments?.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: input.session.id,
                    messageID: input.processor.message.id,
                  })),
                })),
              ),
            )
          }),
        )
      },
    })
  }

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
  })) {
    // A scheduled prompt wakes its session later and a finished sub-agent must never be woken, so a sub-agent's
    // requests never carry the schedule tools (and their tokens). Nor the worktree tools: a sub-agent never moves.
    if (input.session.parentID && ["schedule", "worktree"].includes(Permission.toolPermission(item.id))) continue
    tools[item.id] = registered(item)
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
              ...hookContext,
              sessionID: input.session.id,
              tool: MCP_RESOURCE_TOOLS.list,
              callID: opts.toolCallId,
              args: toRecord(args),
            })
            const ctx = context(
              toRecord(args),
              opts,
              MCP_RESOURCE_TOOLS.list,
              yield* decide({
                toolID: MCP_RESOURCE_TOOLS.list,
                callID: opts.toolCallId,
                decision: preList,
                args: toRecord(args),
                gatedBy: "read",
              }),
            )
            return yield* postTool(
              { toolID: MCP_RESOURCE_TOOLS.list, args, options: opts },
              Effect.gen(function* () {
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
                return {
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
              }),
            )
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
              ...hookContext,
              sessionID: input.session.id,
              tool: MCP_RESOURCE_TOOLS.listTemplates,
              callID: opts.toolCallId,
              args: toRecord(args),
            })
            const ctx = context(
              toRecord(args),
              opts,
              MCP_RESOURCE_TOOLS.listTemplates,
              yield* decide({
                toolID: MCP_RESOURCE_TOOLS.listTemplates,
                callID: opts.toolCallId,
                decision: preTemplates,
                args: toRecord(args),
                gatedBy: "read",
              }),
            )
            return yield* postTool(
              { toolID: MCP_RESOURCE_TOOLS.listTemplates, args, options: opts },
              Effect.gen(function* () {
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
                return {
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
              }),
            )
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
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              throw new Error(`MCP server "${parsed.server}" is not connected`)
            }
            if (!client.getServerCapabilities()?.resources) {
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            }
            const preRead = yield* hooksRunner.runPreToolUse({
              ...hookContext,
              sessionID: input.session.id,
              tool: MCP_RESOURCE_TOOLS.read,
              callID: opts.toolCallId,
              args: toRecord(args),
            })
            const ctx = context(
              toRecord(args),
              opts,
              MCP_RESOURCE_TOOLS.read,
              yield* decide({
                toolID: MCP_RESOURCE_TOOLS.read,
                callID: opts.toolCallId,
                decision: preRead,
                args: toRecord(args),
                gatedBy: "read",
              }),
            )
            return yield* postTool(
              { toolID: MCP_RESOURCE_TOOLS.read, args, options: opts },
              Effect.gen(function* () {
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
                return {
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
              }),
            )
          }),
        )
      },
    })
  }

  if (flags.experimentalCodeMode) return tools

  if (input.toolSearch) tools[input.toolSearch.id] = registered(input.toolSearch)

  for (const key of input.mcp.sent) {
    const entry = input.mcp.tools[key]
    if (!entry) continue
    const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout)
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const pre = yield* preTool(key, args, opts, key)
          const effectiveMcp = pre.args
          const ctx = pre.ctx
          return yield* postTool(
            { toolID: key, args: effectiveMcp, options: opts },
            Effect.gen(function* () {
              const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
                yield* ctx.ask({ permission: key, metadata: { input: effectiveMcp }, patterns: ["*"], always: ["*"] })
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

              return {
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
            }),
          )
        }),
      )
    tools[key] = item
  }

  return tools
}, (effect, input) => effect.pipe(SessionWorkspace.provide(input.session.id)))

export type McpPlan = {
  tools: Record<string, MCP.McpTool>
  /** Visible MCP tool ids sent as normal tools this step, in MCP tool order. */
  sent: string[]
  /** Visible MCP tool ids hidden behind tool_search this step. */
  deferred: string[]
  /**
   * Every deferral-eligible tool, loaded or not: the system prompt's deferred block and the
   * tool_search index. Non-empty exactly while deferral is active.
   */
  listed: Array<{ id: string; server: string }>
}

/**
 * Splits the agent's visible MCP tools into sent and deferred for one provider step.
 * `listed` ignores the loaded set so the system prompt's deferred block stays
 * cache-stable while tools load. `loaded` runs only when something is deferral-eligible,
 * so steps without deferral skip the session read.
 */
export const mcpPlan = Effect.fn("SessionTools.mcpPlan")(function* (input: {
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  loaded: Effect.Effect<ReadonlyArray<string>>
}) {
  const mcp = yield* MCP.Service
  const config = yield* Config.Service
  const flags = yield* RuntimeFlags.Service
  const cfg = yield* config.get()
  const tools = yield* mcp.tools()
  const clients = Object.entries(yield* mcp.clients())
  const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
  const hidden = Permission.disabled([...Object.keys(tools), "tool_search"], ruleset)
  const visible = Object.keys(tools).filter((id) => !hidden.has(id))
  // Tool ids sanitize the server name, so map back through the client instead of parsing the id.
  const serverOf = (id: string) => clients.find((entry) => entry[1] === tools[id]?.client)?.[0] ?? id
  const base = {
    tools: visible,
    servers: Object.fromEntries(
      Object.entries(cfg.mcp ?? {}).map(([name, entry]) => [
        name,
        { defer: "defer" in entry ? entry.defer : undefined },
      ]),
    ),
    serverOf,
    threshold: cfg.experimental?.mcp_defer_threshold ?? 15,
    // Deferring behind a tool_search the agent may not call would strand the tools.
    disabled: flags.disableMcpDefer || flags.experimentalCodeMode || hidden.has("tool_search"),
  }
  const plan = (loaded: ReadonlySet<string>) =>
    Effect.try({ try: () => McpDefer.plan({ ...base, loaded }), catch: (cause) => cause })
  const unplanned: McpPlan = { tools, sent: visible, deferred: [], listed: [] }
  return yield* Effect.gen(function* () {
    const eligible = (yield* plan(new Set())).deferred
    if (eligible.length === 0) return unplanned
    const current = yield* plan(new Set(yield* input.loaded))
    return {
      tools,
      sent: current.sent,
      deferred: current.deferred,
      listed: eligible.map((id) => ({ id, server: serverOf(id) })),
    } satisfies McpPlan
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to plan deferred MCP tools; sending all", { cause }).pipe(Effect.as(unplanned)),
    ),
  )
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
  if ((decision.behavior !== "allow" && decision.behavior !== "ask") || !decision.updatedInput) {
    return { effective: original }
  }
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

// A PreToolUse ask for one call. The call's first permission check under
// `permission` is forced to prompt; `pending` clears once it has.
type Confirm = { permission: string; reason: string | undefined; pending: boolean }

// A copy of `error` whose message ends with a hook's note. The prototype and
// fields are kept, so typed handling downstream (instanceof, tags) still works.
function withNote<T>(error: T, note: string): T {
  if (!(error instanceof Error)) return error
  return Object.defineProperty(
    Object.create(Object.getPrototypeOf(error), Object.getOwnPropertyDescriptors(error)),
    "message",
    { value: `${errorMessage(error)}\n\n${note}`, writable: true, configurable: true, enumerable: false },
  )
}

export * as SessionTools from "./tools"
