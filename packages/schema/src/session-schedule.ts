export * as SessionSchedule from "./session-schedule"

import { define, inventory } from "./event"
import { SessionID } from "./session-id"

// A session's scheduled jobs changed (created, fired, deleted or expired); clients re-list them.
const Updated = define({
  type: "session.schedule.updated",
  schema: {
    sessionID: SessionID,
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
