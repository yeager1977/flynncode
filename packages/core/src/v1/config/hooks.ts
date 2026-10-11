export * as ConfigHooksV1 from "./hooks"

import { Schema } from "effect"

export const HookHandler = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("command"),
    command: Schema.String,
    timeout: Schema.optional(Schema.Number),
    statusMessage: Schema.optional(Schema.String),
    async: Schema.optional(Schema.Boolean),
    additionalContextLimit: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("mcp_tool"),
    server: Schema.String,
    tool: Schema.String,
    input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    timeout: Schema.optional(Schema.Number),
    statusMessage: Schema.optional(Schema.String),
  }),
])
export type HookHandler = Schema.Schema.Type<typeof HookHandler>

export const HookGroup = Schema.Struct({
  matcher: Schema.optional(Schema.String),
  hooks: Schema.mutable(Schema.Array(HookHandler)),
})
export type HookGroup = Schema.Schema.Type<typeof HookGroup>

export const Info = Schema.Struct({
  PreToolUse: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  PermissionRequest: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  PostToolUse: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  SessionStart: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  SessionEnd: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  PreCompact: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  PostCompact: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  UserPromptSubmit: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  SubagentStart: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  SubagentStop: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  Stop: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  Interrupt: Schema.optional(Schema.mutable(Schema.Array(HookGroup))),
  // Kill switch, not an event: everywhere the event table is iterated this
  // key must be guarded against as a non-array value. When true, no hook
  // from configuration runs — managed (MDM) policy hooks included; in-process
  // plugin hooks are unaffected.
  disableAllHooks: Schema.optional(Schema.Boolean).annotate({
    description:
      "Global hook kill switch for file-configured hooks: when true, no hook from configuration runs, including managed (MDM) policy hooks; in-process plugin hooks are unaffected. Default false.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
