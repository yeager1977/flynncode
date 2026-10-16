import type {
  Event,
  createOpencodeClient,
  Project,
  Model,
  Provider,
  Permission,
  UserMessage,
  Message,
  Part,
  Config as SDKConfig,
} from "@flynncode/sdk"
import type { Provider as ProviderV2, Model as ModelV2, Auth } from "@flynncode/sdk/v2"

import type { BunShell } from "./shell.js"
import { type ToolDefinition } from "./tool.js"

export * from "./tool.js"

export type ProviderContext = {
  source: "env" | "config" | "custom" | "api"
  info: Provider
  options: Record<string, any>
}

export type WorkspaceInfo = {
  id: string
  type: string
  name: string
  branch: string | null
  directory: string | null
  extra: unknown | null
  projectID: string
}

export type WorkspaceTarget =
  | {
      type: "local"
      directory: string
    }
  | {
      type: "remote"
      url: string | URL
      headers?: HeadersInit
    }

export type WorkspaceAdapter = {
  name: string
  description: string
  configure(config: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(config: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>
  remove(config: WorkspaceInfo): Promise<void>
  target(config: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>
}

export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string
  worktree: string
  experimental_workspace: {
    register(type: string, adapter: WorkspaceAdapter): void
  }
  serverUrl: URL
  $: BunShell
}

export type PluginOptions = Record<string, unknown>

export type Config = Omit<SDKConfig, "plugin"> & {
  plugin?: Array<string | [string, PluginOptions]>
}

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

export type PluginModule = {
  id?: string
  server: Plugin
  tui?: never
}

type Rule = {
  key: string
  op: "eq" | "neq"
  value: string
}

export type ProviderUsageWindow = {
  id: string
  /** Utilization from 0 to 100, when the provider knows a utilizable limit. */
  percent?: number
  /** Absolute usage inside the window (e.g. requests), when the provider reports counts instead. */
  count?: number
  /** Epoch milliseconds when the window resets, if known. */
  resetsAt?: number
}

export type ProviderUsage = {
  windows: ProviderUsageWindow[]
}

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  /**
   * Optional subscription usage for this provider's account. Return undefined
   * when the credential in auth cannot produce a usage snapshot (expired,
   * unsupported, offline) — UIs simply omit meters for the provider.
   */
  usage?: (auth: () => Promise<Auth>) => Promise<ProviderUsage | undefined>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>
      }
    | {
        type: "api"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
        >
        authorize?(inputs?: Record<string, string>): Promise<
          | {
              type: "success"
              key: string
              provider?: string
              metadata?: Record<string, string>
            }
          | {
              type: "failed"
            }
        >
      }
  )[]
}

export type AuthOAuthResult = { url: string; instructions: string } & (
  | {
      method: "auto"
      callback(): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
                enterpriseUrl?: string
              }
            | { key: string; metadata?: Record<string, string> }
          ))
        | {
            type: "failed"
          }
      >
    }
  | {
      method: "code"
      callback(code: string): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
                enterpriseUrl?: string
              }
            | { key: string; metadata?: Record<string, string> }
          ))
        | {
            type: "failed"
          }
      >
    }
)

export type ProviderHookContext = {
  auth?: Auth
}

export type ProviderHook = {
  id: string
  models?: (provider: ProviderV2, ctx: ProviderHookContext) => Promise<Record<string, ModelV2>>
}

/** @deprecated Use AuthOAuthResult instead. */
export type AuthOuathResult = AuthOAuthResult

/**
 * The `permission.ask` hook input carries the fields the ask path knows: the
 * permission name, all patterns, the requesting tool name, its arguments, and
 * the session. It reuses the response-shaped {@link Permission} payload where
 * the ask path can fill it honestly: `type`, `pattern`, `sessionID`,
 * `metadata`, `title` (the tool or permission name), and `time.created` (now)
 * are always present, while `id`, `messageID`, `callID`, `tool`, and `args`
 * are omitted entirely (missing keys, not sentinels) when the ask carries no
 * value for them.
 */
export type PermissionAskInput = Omit<Permission, "id" | "messageID" | "title" | "time"> & {
  id?: Permission["id"]
  messageID?: Permission["messageID"]
  title?: Permission["title"]
  time?: Permission["time"]
  permission?: string
  patterns?: Array<string>
  tool?: string
  args?: Record<string, unknown>
}

export interface Hooks {
  dispose?: () => Promise<void>
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: {
    [key: string]: ToolDefinition
  }
  auth?: AuthHook
  provider?: ProviderHook
  /**
   * Called when a new message is received
   */
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>
  /**
   * Modify parameters sent to LLM
   */
  "chat.params"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: {
      temperature: number
      topP: number
      topK: number
      maxOutputTokens: number | undefined
      options: Record<string, any>
    },
  ) => Promise<void>
  "chat.headers"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { headers: Record<string, string> },
  ) => Promise<void>
  /**
   * Runs before any approval-mode shortcut auto-approves a request that needs
   * asking: a `deny` verdict wins in every mode (including "auto",
   * "accept-edits", and the always-ask tools), while `allow` and `ask` fall
   * through to the mode shortcuts and the normal prompt flow.
   */
  // Declared as a method (not a property) on purpose: parameter assignability
  // for method signatures stays bivariant under strictFunctionTypes, so hooks
  // explicitly annotated with the response-shaped Permission input keep
  // compiling against the narrower PermissionAskInput payload. Verified with
  // tsc --strict: a property-style slot (or a `Permission | PermissionAskInput`
  // union parameter) fails TS2322 for those legacy hooks.
  "permission.ask"?(input: PermissionAskInput, output: { status: "ask" | "deny" | "allow" }): Promise<void>
  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
  ) => Promise<void>
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>
  "shell.env"?: (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: {
      title: string
      output: string
      metadata: any
    },
  ) => Promise<void>
  "experimental.chat.messages.transform"?: (
    input: {},
    output: {
      messages: {
        info: Message
        parts: Part[]
      }[]
    },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model },
    output: {
      system: string[]
    },
  ) => Promise<void>
  "experimental.provider.small_model"?: (input: { provider: ProviderV2 }, output: { model?: ModelV2 }) => Promise<void>
  /**
   * Called before session compaction starts. Allows plugins to customize
   * the compaction prompt.
   *
   * - `context`: Additional context strings appended to the default prompt
   * - `prompt`: If set, replaces the default compaction prompt entirely
   */
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>
  /**
   * Called after compaction succeeds and before a synthetic user
   * auto-continue message is added.
   *
   * - `enabled`: Defaults to `true`. Set to `false` to skip the synthetic
   *   user "continue" turn.
   */
  "experimental.compaction.autocontinue"?: (
    input: {
      sessionID: string
      agent: string
      model: Model
      provider: ProviderContext
      message: UserMessage
      overflow: boolean
    },
    output: { enabled: boolean },
  ) => Promise<void>
  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>
  /**
   * Modify tool definitions (description and parameters) sent to LLM
   */
  "tool.definition"?: (input: { toolID: string }, output: { description: string; parameters: any }) => Promise<void>
  "tool.permission"?: (
    input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
    output: { decision: "allow" | "deny" | "undecided"; message?: string; updatedInput?: Record<string, unknown> },
  ) => Promise<void>
  "session.start"?: (
    input: { sessionID: string; source: "startup" | "resume" | "clear" | "compact" },
    output: { additionalContext?: string; systemMessage?: string },
  ) => Promise<void>
  "session.end"?: (
    input: { sessionID: string; reason: "other" },
    output: { systemMessage?: string },
  ) => Promise<void>
  "session.prompt"?: (
    input: { sessionID: string; prompt: string },
    output: { additionalContext?: string; systemMessage?: string },
  ) => Promise<void>
  "session.compact"?: (
    input: { sessionID: string; trigger: "manual" | "auto"; phase: "pre" | "post" },
    output: { additionalContext?: string; systemMessage?: string; continue?: boolean },
  ) => Promise<void>
  "session.idle"?: (
    input: { sessionID: string; reason: "idle" | "interrupt" },
    output: { additionalContext?: string; systemMessage?: string },
  ) => Promise<void>
  "subagent.start"?: (
    input: { sessionID: string; agentID: string; agentType: string },
    output: { additionalContext?: string; systemMessage?: string },
  ) => Promise<void>
  "subagent.stop"?: (
    input: { sessionID: string; agentID: string; agentType: string },
    output: { additionalContext?: string; systemMessage?: string; continue?: boolean; stopReason?: string },
  ) => Promise<void>
}
