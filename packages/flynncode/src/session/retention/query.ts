export * as SessionRetentionQuery from "./query"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@flynncode/core/database/database"
import { SessionID } from "@/session/schema"

export type Tree = {
  /** The root session. */
  id: SessionID
  directory: string
  /**
   * The newest write anywhere in the tree, in epoch milliseconds: session, message, part, todo, folder and V2 message
   * rows, and the latest V2 input. The same rows machine sync dates a chat by, so a retention tombstone stamped from
   * it outranks a peer copy only when that copy has nothing newer.
   */
  latest: number
  /** `keep: true` in the root's metadata. */
  keep: boolean
  /** `retentionHold: true` in the root's metadata: some machine has an unexpired scheduled job in the tree. */
  hold: boolean
  /** Some session of the tree has an unexpired scheduled job (cron or wakeup) in this database. */
  scheduled: boolean
  /** The root and every descendant. */
  members: SessionID[]
}

type Row = {
  id: string
  directory: string
  latest: number
  keep: number
  hold: number
  scheduled: number
  members: string
}

/**
 * One row per root session (`parent_id IS NULL`), optionally only `root`. Each member's newest write is a single seek
 * into a `(session_id, …)` index of each table, so the cost grows with the number of sessions and never with the size
 * of the message or part tables. A session whose parent is missing is never reached: it belongs to no tree this
 * machine can see whole. An expired job no longer counts: only the leader of the kind that created it prunes it, and
 * that kind of server may never run here again.
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
        coalesce((SELECT max(time_updated) FROM session_message WHERE session_id = tree.id), 0),
        coalesce((SELECT max(time_updated) FROM todo WHERE session_id = tree.id), 0),
        coalesce((SELECT max(time_updated) FROM session_folder WHERE session_id = tree.id), 0),
        coalesce((
          SELECT time_created FROM session_input WHERE session_id = tree.id ORDER BY admitted_seq DESC LIMIT 1
        ), 0)
      )) AS latest,
      coalesce(json_valid(root.metadata) AND json_type(root.metadata, '$.keep') = 'true', 0) AS keep,
      coalesce(json_valid(root.metadata) AND json_type(root.metadata, '$.retentionHold') = 'true', 0) AS hold,
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
      hold: row.hold === 1,
      scheduled: row.scheduled === 1,
      members: (JSON.parse(row.members) as string[]).map((id) => SessionID.make(id)),
    }),
  )
})

/**
 * Whether a member's turn may still be running in some process: its latest assistant message has no completion time.
 * A newer assistant message ends an older unfinished one (a crash orphaned it), so only the latest counts. The bound
 * the scheduler puts on this (recent writes) does not fit retention, which only looks at trees idle for days: a turn
 * waiting on a permission or a question writes nothing while it waits. A turn a crash left unfinished keeps its tree
 * until the session runs again.
 */
export const unfinished = Effect.fn("SessionRetentionQuery.unfinished")(function* (
  database: Database.Interface,
  members: SessionID[],
) {
  const row = yield* database.db
    .get<{ found: number }>(
      sql`SELECT 1 AS found FROM json_each(${JSON.stringify(members)}) AS member
        WHERE (
          SELECT json_extract(data, '$.time.completed') IS NULL FROM message
          WHERE session_id = member.value AND json_extract(data, '$.role') = 'assistant'
          ORDER BY time_created DESC, id DESC
          LIMIT 1
        ) = 1
        LIMIT 1`,
    )
    .pipe(Effect.orDie)
  return row !== undefined
})
