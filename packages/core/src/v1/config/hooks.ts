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
  hooks: Schema.Array(HookHandler),
})
export type HookGroup = Schema.Schema.Type<typeof HookGroup>

export const Info = Schema.Struct({
  PreToolUse: Schema.optional(Schema.Array(HookGroup)),
  PermissionRequest: Schema.optional(Schema.Array(HookGroup)),
  PostToolUse: Schema.optional(Schema.Array(HookGroup)),
  SessionStart: Schema.optional(Schema.Array(HookGroup)),
  SessionEnd: Schema.optional(Schema.Array(HookGroup)),
  PreCompact: Schema.optional(Schema.Array(HookGroup)),
  PostCompact: Schema.optional(Schema.Array(HookGroup)),
  UserPromptSubmit: Schema.optional(Schema.Array(HookGroup)),
  SubagentStart: Schema.optional(Schema.Array(HookGroup)),
  SubagentStop: Schema.optional(Schema.Array(HookGroup)),
  Stop: Schema.optional(Schema.Array(HookGroup)),
  Interrupt: Schema.optional(Schema.Array(HookGroup)),
})
export type Info = Schema.Schema.Type<typeof Info>
