export * as SessionStatusLine from "./session-statusline"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"

// The session's last status line output: up to two lines, ANSI SGR codes kept, padding applied. `updatedAt` (epoch
// milliseconds) is the last run that produced output; it is missing until one has.
export const Result = Schema.Struct({
  lines: Schema.Array(Schema.String),
  updatedAt: optional(NonNegativeInt),
}).annotate({ identifier: "SessionStatusLine" })
export interface Result extends Schema.Schema.Type<typeof Result> {}

// The session's status line changed; an empty `lines` hides it.
const Updated = define({
  type: "session.statusline",
  schema: {
    sessionID: SessionID,
    lines: Schema.Array(Schema.String),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
