export * as SessionRetentionQuery from "./query"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@flynncode/core/database/database"
import { SessionID } from "@/session/schema"

export type Tree = {
  /** The root session. */
  id: SessionID
  directory: string
  /** The newest session, message or part write anywhere in the tree, in epoch milliseconds. */
  latest: number
  /** `keep: true` in the root's metadata. */
  keep: boolean
  /** Some session of the tree has an unexpired scheduled job (cron or wakeup). */
  scheduled: boolean
  /** The root and every descendant. */
  members: SessionID[]
}

type Row = { id: string; directory: string; latest: number; keep: number; scheduled: number; members: string }

/**
 * One row per root session (`parent_id IS NULL`), optionally only `root`. Each member's newest message, part and V2
 * message write is a single seek into the `(session_id, time_updated)` index of that table, so the cost grows with
 * the number of sessions and never with the size of the message or part tables. A session whose parent is missing is
 * never reached: it belongs to no tree this machine can see whole. An expired job no longer counts: only the leader of
 * the kind that created it prunes it, and that kind of server may never run here again.
 */
export function statement(now: number, root?: SessionID) {
  return sql`WITH RECURSIVE tree(id, root) AS (
      SELECT id, id FROM session WHERE parent_id IS NULL${root === undefined ? sql`` : sql` AND id = ${root}`}
      UNION
      SELECT child.id, tree.root FROM session child JOIN tree ON child.parent_id = tree.id
    )
    SELECT
      tree.root AS id,
      root.directory AS directory,
      max(max(
        member.time_updated,
        coalesce((SELECT max(time_updated) FROM message WHERE session_id = tree.id), 0),
        coalesce((SELECT max(time_updated) FROM part WHERE session_id = tree.id), 0),
        coalesce((SELECT max(time_updated) FROM session_message WHERE session_id = tree.id), 0)
      )) AS latest,
      coalesce(json_valid(root.metadata) AND json_type(root.metadata, '$.keep') = 'true', 0) AS keep,
      max(EXISTS (
        SELECT 1 FROM session_schedule
        WHERE session_id = tree.id AND (expires_at IS NULL OR expires_at > ${now})
      )) AS scheduled,
      json_group_array(tree.id) AS members
    FROM tree
    JOIN session member ON member.id = tree.id
    JOIN session root ON root.id = tree.root
    GROUP BY tree.root`
}

export const trees = Effect.fn("SessionRetentionQuery.trees")(function* (
  database: Database.Interface,
  now: number,
  root?: SessionID,
) {
  const rows = yield* database.db.all<Row>(statement(now, root)).pipe(Effect.orDie)
  return rows.map(
    (row): Tree => ({
      id: SessionID.make(row.id),
      directory: row.directory,
      latest: row.latest,
      keep: row.keep === 1,
      scheduled: row.scheduled === 1,
      members: (JSON.parse(row.members) as string[]).map((id) => SessionID.make(id)),
    }),
  )
})
