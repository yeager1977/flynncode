export * as SessionSchedule from "./session-schedule"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"

export const Kind = Schema.Literals(["cron", "wakeup"]).annotate({ identifier: "SessionScheduleKind" })
export type Kind = typeof Kind.Type

// The public shape of a scheduled job; lease and failure bookkeeping stay internal. Times are epoch milliseconds.
export const Info = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  cron: optional(Schema.String),
  prompt: Schema.String,
  reason: optional(Schema.String),
  recurring: Schema.Boolean,
  nextRunAt: NonNegativeInt,
  expiresAt: optional(NonNegativeInt),
}).annotate({ identifier: "SessionSchedule" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

// A session's scheduled jobs changed (created, fired, deleted or expired); clients re-list them.
const Updated = define({
  type: "session.schedule.updated",
  schema: {
    sessionID: SessionID,
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
