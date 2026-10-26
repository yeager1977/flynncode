export * as ShellBackground from "./shell-background"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt, optional } from "./schema"

export const Status = Schema.Literals(["running", "exited", "killed", "timed_out"]).annotate({
  identifier: "BackgroundShellStatus",
})
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  command: Schema.String,
  pid: NonNegativeInt,
  outputPath: Schema.String,
  startedAt: NonNegativeInt,
  status: Status,
  exitCode: optional(Schema.Int),
  endedAt: optional(NonNegativeInt),
}).annotate({ identifier: "BackgroundShell" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

// `offset` is the logical stream position to read from next; `skipped` counts bytes after the requested offset that
// are no longer held (the text then starts with a skipped marker).
export const Chunk = Schema.Struct({
  text: Schema.String,
  offset: NonNegativeInt,
  skipped: NonNegativeInt,
  truncated: Schema.Boolean,
}).annotate({ identifier: "BackgroundShellOutput" })
export interface Chunk extends Schema.Schema.Type<typeof Chunk> {}

const Started = define({
  type: "shell.background.started",
  schema: {
    sessionID: Schema.String,
    id: Schema.String,
    command: Schema.String,
    pid: NonNegativeInt,
    startedAt: NonNegativeInt,
  },
})
// Throttled to at most one per second per shell; `bytes` is the total written so far and `tail` its last 4 KiB.
const Output = define({
  type: "shell.background.output",
  schema: {
    sessionID: Schema.String,
    id: Schema.String,
    bytes: NonNegativeInt,
    tail: Schema.String,
  },
})
const Exited = define({
  type: "shell.background.exited",
  schema: {
    sessionID: Schema.String,
    id: Schema.String,
    status: Status,
    exitCode: optional(Schema.Int),
  },
})
export const Event = {
  Started,
  Output,
  Exited,
  Definitions: inventory(Started, Output, Exited),
}
