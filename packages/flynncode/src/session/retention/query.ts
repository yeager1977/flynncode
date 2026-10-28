export * as SessionRetentionQuery from "./query"

import { sql, type SQL } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@flynncode/core/database/database"
import { SessionActivity } from "@/session/activity"
import { SessionID } from "@/session/schema"

export type Tree = {
  /** The root session. */
  id: SessionID
  directory: string
  /**
   * The newest write anywhere in the tree, in epoch milliseconds: the session rows and `SessionActivity.content`. The
   * same rows machine sync dates a chat by, so a retention tombstone stamped from it outranks a peer copy only when
   * that copy has nothing newer.
   */
  latest: number
  /** `keep: true` in the root's metadata. */
  keep: boolean
  /**
   * A schedule hold that has not lapsed: `retentionHold: true` in the root's metadata, with `retentionHoldUntil` still
   * ahead. Some machine has an unexpired scheduled job in the tree and refreshes the hold while it does.
   */
  hold: boolean
  /** `retentionHoldUntil` of a hold in the root's metadata, lapsed or not (0 when it has none); absent without one. */
  holdUntil?: number
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
  hold_until: number | null
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
      max(max(member.time_updated, ${SessionActivity.content(sql`tree.id`)})) AS latest,
      ${keeps(sql`root.metadata`)} AS keep,
      ${holdUntil(sql`root.metadata`)} AS hold_until,
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
      hold: row.hold_until !== null && row.hold_until > now,
      ...(row.hold_until === null ? {} : { holdUntil: row.hold_until }),
      scheduled: row.scheduled === 1,
      members: (JSON.parse(row.members) as string[]).map((id) => SessionID.make(id)),
    }),
  )
})

/** `keep: true` in a session's metadata, as 0 or 1. */
export function keeps(metadata: SQL) {
  return sql`CASE WHEN coalesce(json_valid(${metadata}), 0) THEN coalesce(json_type(${metadata}, '$.keep') = 'true', 0) ELSE 0 END`
}

/**
 * The `retentionHoldUntil` of a schedule hold in a session's metadata: NULL without `retentionHold: true`, 0 for a hold
 * without a numeric expiry (it counts as lapsed).
 */
export function holdUntil(metadata: SQL) {
  return sql`CASE
    WHEN NOT coalesce(json_valid(${metadata}), 0) THEN NULL
    WHEN coalesce(json_type(${metadata}, '$.retentionHold') = 'true', 0) THEN
      CASE WHEN json_type(${metadata}, '$.retentionHoldUntil') IN ('integer', 'real')
        THEN json_extract(${metadata}, '$.retentionHoldUntil') ELSE 0 END
  END`
}

/**
 * Whether a member's turn may still be running or waiting in some process, by what the database persists:
 * - its latest V1 assistant message has no completion time;
 * - its latest V2 assistant message has no completion time (a V2 turn waiting on a permission or a question keeps it
 *   open, whichever process drives it);
 * - it has a V2 input admitted but not yet promoted into the transcript (a turn is queued for it).
 * A newer assistant message ends an older unfinished one (a crash orphaned it), so only the latest counts. The bound
 * the scheduler puts on this (recent writes) does not fit retention, which only looks at trees idle for days: a turn
 * waiting on a permission or a question writes nothing while it waits. A turn or input a crash left unfinished keeps
 * its tree until the session runs again.
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
        OR (
          SELECT json_extract(data, '$.time.completed') IS NULL FROM session_message
          WHERE session_id = member.value AND type = 'assistant'
          ORDER BY seq DESC
          LIMIT 1
        ) = 1
        OR EXISTS (SELECT 1 FROM session_input WHERE session_id = member.value AND promoted_seq IS NULL)
        LIMIT 1`,
    )
    .pipe(Effect.orDie)
  return row !== undefined
})
