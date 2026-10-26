export * as ConfigCommandV1 from "./command"

import { Schema } from "effect"

export const Info = Schema.Struct({
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  subtask: Schema.optional(Schema.Boolean),
  // Fields below come from Claude Code slash commands (`.claude/commands`).
  argumentHint: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  disableModelInvocation: Schema.optional(Schema.Boolean),
  // Claude model alias (`opus`, `sonnet`, `haiku`, `inherit`) resolved at run
  // time; never sent to a provider.
  claudeModel: Schema.optional(Schema.String),
  // File a Claude Code command was loaded from. Marks the entry as Claude
  // sourced so it can never replace a built-in command.
  claudeSource: Schema.optional(Schema.String),
})
export type Info = Schema.Schema.Type<typeof Info>
