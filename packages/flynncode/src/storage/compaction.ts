import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@flynncode/core/database/database"
import { DatabaseMaintenance } from "@flynncode/core/database/maintenance"

type Db = Database.Interface["db"]

const DAY = 24 * 60 * 60 * 1000
const CHUNK = 20

export type Options = {
  now: number
  /** Days a classic session stays idle before its projected message events are deleted. */
  eventIdleDays: number
  /** Days a session stays idle before inline media is stripped from its tool results; never when undefined. */
  mediaIdleDays?: number
}

export type Estimate = {
  /** Bytes of the database file in use, free pages excluded. */
  usedBytes: number
  freeBytes: number
  events: { sessions: number; rows: number; bytes: number }
  media: { sessions: number; parts: number; attachments: number; bytes: number }
}

// Classic sessions with nothing written since the cutoff and no turn waiting. Message and part writes do not bump
// session.time_updated, so idleness is read from all three (each is indexed on session_id, time_updated).
const idle = (cutoff: number) => sql`
  SELECT s.id FROM session s
  WHERE s.time_updated < ${cutoff}
    AND NOT EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM session_input i WHERE i.session_id = s.id AND i.promoted_seq IS NULL)
    AND NOT EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.time_updated >= ${cutoff})
    AND NOT EXISTS (SELECT 1 FROM part p WHERE p.session_id = s.id AND p.time_updated >= ${cutoff})`

// A completed tool result that still carries an attachment inline as a `data:` URL. The LIKE runs first so the JSON
// of the many parts without attachments is never parsed.
const inline = sql`p.data LIKE '%"attachments":[{%'
  AND EXISTS (
    SELECT 1 FROM json_each(p.data, '$.state.attachments') a
    WHERE json_extract(a.value, '$.url') LIKE 'data:%')`

/**
 * What `run` would reclaim with the same options, without writing. Bytes are the stored JSON text; the file shrinks by
 * about that much plus the freed index entries.
 */
export const estimate = Effect.fn("StorageCompaction.estimate")(function* (db: Db, options: Options) {
  const size = yield* db.get<{ used: number; free: number }>(
    sql`SELECT (p.page_count - f.freelist_count) * s.page_size AS used, f.freelist_count * s.page_size AS free
        FROM pragma_page_count p, pragma_freelist_count f, pragma_page_size s`,
  )
  const prunable = yield* DatabaseMaintenance.prunable(db, options.now - options.eventIdleDays * DAY)
  const events = yield* db.get<{ rows: number; bytes: number | null }>(
    sql`SELECT count(*) AS rows, sum(length(e.data)) AS bytes FROM event e
        WHERE e.aggregate_id IN (SELECT value FROM json_each(${JSON.stringify(prunable.map((row) => row.id))}))
          AND e.type >= 'message.' AND e.type < 'message/'`,
  )
  const media =
    options.mediaIdleDays === undefined
      ? undefined
      : yield* db.get<{ sessions: number; parts: number; attachments: number | null; bytes: number | null }>(
          sql`SELECT count(DISTINCT p.session_id) AS sessions, count(*) AS parts,
                sum((SELECT count(*) FROM json_each(p.data, '$.state.attachments') a
                     WHERE json_extract(a.value, '$.url') LIKE 'data:%')) AS attachments,
                sum((SELECT sum(length(json_extract(a.value, '$.url'))) FROM json_each(p.data, '$.state.attachments') a
                     WHERE json_extract(a.value, '$.url') LIKE 'data:%')) AS bytes
              FROM part p
              WHERE p.session_id IN (${idle(options.now - options.mediaIdleDays * DAY)}) AND ${inline}`,
        )
  return {
    usedBytes: size?.used ?? 0,
    freeBytes: size?.free ?? 0,
    events: { sessions: prunable.length, rows: events?.rows ?? 0, bytes: events?.bytes ?? 0 },
    media: {
      sessions: media?.sessions ?? 0,
      parts: media?.parts ?? 0,
      attachments: media?.attachments ?? 0,
      bytes: media?.bytes ?? 0,
    },
  } satisfies Estimate
})

/**
 * Removes inline `data:` attachments (screenshots, PDFs) from the completed tool results of sessions idle since
 * `cutoff`, and says so at the end of the tool's text output, which stays. Attachments stored by reference stay too.
 * The rows' `time_updated` is left alone on purpose: machine sync and session retention date a chat by it, so the
 * strip neither pushes this copy over a peer's nor restarts the chat's retention clock.
 */
export const stripIdleMedia = Effect.fn("StorageCompaction.stripIdleMedia")(function* (
  db: Db,
  input: { cutoff: number; chunk?: number },
) {
  const sessions = yield* db.all<{ id: string }>(idle(input.cutoff))
  // Parts carry megabytes each, so the chunks are small; idleness is re-checked in every chunk because a session can
  // be resumed between selection and the write.
  const parts = yield* Effect.forEach(sessions, (session) =>
    DatabaseMaintenance.deleteChunked(
      db,
      (limit) => sql`UPDATE part SET data = json_set(
          data,
          '$.state.attachments', json((
            SELECT json_group_array(json(a.value)) FROM json_each(part.data, '$.state.attachments') a
            WHERE json_extract(a.value, '$.url') NOT LIKE 'data:%')),
          '$.state.output', coalesce(json_extract(data, '$.state.output'), '') || char(10) || char(10) ||
            '[Attachments removed from stored history to save space: ' || (
              SELECT group_concat(coalesce(json_extract(a.value, '$.filename'), json_extract(a.value, '$.mime')), ', ')
              FROM json_each(part.data, '$.state.attachments') a
              WHERE json_extract(a.value, '$.url') LIKE 'data:%') || ']')
        WHERE rowid IN (
          SELECT p.rowid FROM part p
          WHERE p.session_id = ${session.id} AND ${inline}
            AND p.session_id IN (${idle(input.cutoff)})
          LIMIT ${limit})`,
      input.chunk ?? CHUNK,
    ),
  )
  return { sessions: parts.filter((count) => count > 0).length, parts: parts.reduce((sum, count) => sum + count, 0) }
})

/**
 * Deletes the projected message events of idle classic sessions, strips inline media when `mediaIdleDays` is set, and
 * hands the freed pages back to the filesystem (on a database already converted to incremental auto_vacuum).
 */
export const run = Effect.fn("StorageCompaction.run")(function* (db: Db, options: Options) {
  const events = yield* DatabaseMaintenance.pruneIdleSessions(db, {
    now: options.now,
    idleMs: options.eventIdleDays * DAY,
  })
  const media =
    options.mediaIdleDays === undefined
      ? { sessions: 0, parts: 0 }
      : yield* stripIdleMedia(db, { cutoff: options.now - options.mediaIdleDays * DAY })
  const freedPages = yield* DatabaseMaintenance.reclaim(db)
  if (freedPages > 0) yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.ignoreCause)
  return { events, media, freedPages }
})

export * as StorageCompaction from "./compaction"
