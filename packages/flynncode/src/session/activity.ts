export * as SessionActivity from "./activity"

import { sql, type SQL } from "drizzle-orm"

/**
 * The newest content write of one session, in epoch milliseconds (0 when it has none): its message, part, todo, folder
 * and V2 message rows by `time_updated`, and its V2 inputs by `time_created`, since inputs are never updated. The
 * session row's own `time_updated` is left to the caller.
 *
 * Machine sync dates a chat by this and its session row, and session retention dates a tree by it over every member,
 * so a retention tombstone stamped from it compares exactly against a peer's sync version. Each term is one seek into
 * a `(session_id, …)` index, so the cost never grows with the size of the message or part tables.
 */
export function content(sessionID: SQL) {
  return sql`max(
    coalesce((SELECT max(time_updated) FROM message WHERE session_id = ${sessionID}), 0),
    coalesce((SELECT max(time_updated) FROM part WHERE session_id = ${sessionID}), 0),
    coalesce((SELECT max(time_updated) FROM session_message WHERE session_id = ${sessionID}), 0),
    coalesce((SELECT max(time_updated) FROM todo WHERE session_id = ${sessionID}), 0),
    coalesce((SELECT max(time_updated) FROM session_folder WHERE session_id = ${sessionID}), 0),
    coalesce((SELECT max(time_created) FROM session_input WHERE session_id = ${sessionID}), 0)
  )`
}
