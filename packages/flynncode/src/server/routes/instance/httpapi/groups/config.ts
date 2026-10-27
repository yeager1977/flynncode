import { Config } from "@/config/config"
import { ConfigV1 } from "@flynncode/core/v1/config/config"
import { Provider } from "@/provider/provider"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const HooksTrustEntry = Schema.Struct({
  hash: Schema.String,
  event: Schema.String,
  matcher: Schema.String,
  summary: Schema.String,
  trusted: Schema.Boolean,
  trustedAt: Schema.optional(Schema.Number),
  managed: Schema.Boolean,
  source: Schema.optional(Schema.String),
}).annotate({ identifier: "HooksTrustEntry" })
export type HooksTrustEntry = Schema.Schema.Type<typeof HooksTrustEntry>

export const ClaudeHookSource = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["user", "project", "plugin"]),
  label: Schema.String,
  root: Schema.optional(Schema.String),
  events: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  // Disabled by a claude_hooks.disabled entry outside the global config file,
  // which the global switch cannot turn back on.
  disabledByProject: Schema.optional(Schema.Boolean),
  warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "ClaudeHookSource" })

export const HooksTrustList = Schema.Struct({
  hooks: Schema.Array(HooksTrustEntry),
  bypass: Schema.Boolean,
  claudeSources: Schema.Array(ClaudeHookSource),
  claudeWarnings: Schema.Array(Schema.String),
  claudeDisabled: Schema.Boolean,
}).annotate({ identifier: "HooksTrustList" })

export const ClaudeHookToggleInput = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
}).annotate({ identifier: "ClaudeHookToggleInput" })

export const HooksHashInput = Schema.Struct({
  hash: Schema.String,
}).annotate({ identifier: "HooksHashInput" })

const root = "/config"

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current Flynncode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("projectGet", `${root}/project`, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.Info, "Get project config file info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.project.get",
            summary: "Get project configuration",
            description:
              "Retrieve only the project configuration file that project updates write to, without global or inherited settings.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV1.Info,
          success: described(ConfigV1.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description:
              "Patch the project configuration file with only the provided keys. Writes the closest existing opencode.jsonc or opencode.json, or creates opencode.json in the project directory.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
        HttpApiEndpoint.get("hooksTrust", `${root}/hooks/trust`, {
          query: WorkspaceRoutingQuery,
          success: described(HooksTrustList, "List hooks with trust state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.hooks.trust.list",
            summary: "List hooks trust state",
            description:
              "List configured file hooks with their trust state for review in settings. Managed hooks are trusted by policy and cannot be disabled.",
          }),
        ),
        HttpApiEndpoint.post("hooksTrustOne", `${root}/hooks/trust`, {
          query: WorkspaceRoutingQuery,
          payload: HooksHashInput,
          success: described(HooksTrustEntry, "Trusted hook entry"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.hooks.trust.approve",
            summary: "Trust a hook",
            description: "Pin the current hash of a hook definition as trusted after review.",
          }),
        ),
        HttpApiEndpoint.post("hooksRevoke", `${root}/hooks/revoke`, {
          query: WorkspaceRoutingQuery,
          payload: HooksHashInput,
          success: described(HooksTrustEntry, "Revoked hook entry"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.hooks.trust.revoke",
            summary: "Revoke hook trust",
            description: "Remove trust for a hook hash. Managed hooks cannot be revoked.",
          }),
        ),
        HttpApiEndpoint.post("hooksClaudeToggle", `${root}/hooks/claude`, {
          query: WorkspaceRoutingQuery,
          payload: ClaudeHookToggleInput,
          success: described(HooksTrustList, "Hooks with trust state after the change"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.hooks.claude.toggle",
            summary: "Turn a Claude Code hook source on or off",
            description:
              "Add or remove a Claude Code hook source id in claude_hooks.disabled in the global config file. A source disabled by project config stays disabled.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
