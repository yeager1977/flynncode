export * as SessionRetention from "./session-retention"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt, optional, PositiveInt } from "./schema"
import { SessionID } from "./session-id"

// A root session whose tree is deleted at `deletesAt` (epoch milliseconds) unless it becomes active or is kept. It
// can be in the past when the tree waits for the next pass.
export const Expiring = Schema.Struct({
  sessionID: SessionID,
  deletesAt: NonNegativeInt,
}).annotate({ identifier: "SessionRetentionExpiring" })

// What the app needs for its hints. `firstRunAt` and `pendingFirstRunCount` are present only while the first pass
// that found more than 20 deletable trees is delayed: the trees are deleted at `firstRunAt`.
export const Info = Schema.Struct({
  cleanupPeriodDays: PositiveInt,
  firstRunAt: optional(NonNegativeInt),
  pendingFirstRunCount: optional(NonNegativeInt),
  expiring: Schema.Array(Expiring),
}).annotate({ identifier: "SessionRetention" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

// A retention pass ran or the period changed; clients refetch `GET /session/retention`.
const Updated = define({
  type: "session.retention.updated",
  schema: {},
})
export const Event = { Updated, Definitions: inventory(Updated) }
