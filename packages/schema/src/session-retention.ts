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

// What the app needs for its hints and pin icons. `kept` lists the root sessions whose metadata has `keep: true`,
// because the session list the app loads carries no metadata. `held` lists the root sessions a scheduled job protects:
// a schedule hold that has not lapsed, or a job in this database. `firstRunAt` and `pendingFirstRunCount` are present
// only while a pass that would delete more than 20 trees at once is delayed: the trees are deleted at `firstRunAt`.
export const Info = Schema.Struct({
  cleanupPeriodDays: PositiveInt,
  firstRunAt: optional(NonNegativeInt),
  pendingFirstRunCount: optional(NonNegativeInt),
  expiring: Schema.Array(Expiring),
  kept: Schema.Array(SessionID),
  held: Schema.Array(SessionID),
}).annotate({ identifier: "SessionRetention" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

// A retention pass ran or the period changed; clients refetch `GET /session/retention`.
const Updated = define({
  type: "session.retention.updated",
  schema: {},
})
export const Event = { Updated, Definitions: inventory(Updated) }
