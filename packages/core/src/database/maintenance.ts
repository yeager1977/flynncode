export * as DatabaseMaintenance from "./maintenance"

import { sql, type SQL } from "drizzle-orm"
import { Effect } from "effect"
import type { Interface } from "./database"

type Db = Interface["db"]

export const IDLE_MS = 7 * 24 * 60 * 60 * 1000
const CHUNK = 2_000

// Classic (v1) sessions keep their authoritative state in message/part rows;
// their message.* events are a duplicate log that only sync and replay of
// recent work read. Once a session has been idle for IDLE_MS those events are
// dead weight (they were 30GB of a 38GB database). v2 sessions build history
// from events and are never pruned; event_sequence is kept so a resumed
// session appends at seq + 1.
export const pruneIdleSessions = Effect.fn("DatabaseMaintenance.pruneIdleSessions")(function* (
  db: Db,
  input: { now: number; idleMs?: number; chunk?: number },
) {
  const cutoff = input.now - (input.idleMs ?? IDLE_MS)
  const candidates = yield* db.all<{ id: string }>(sql`
    SELECT s.id FROM session s
    JOIN event_sequence q ON q.aggregate_id = s.id
    WHERE s.time_updated < ${cutoff}
      AND q.owner_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM session_input i WHERE i.session_id = s.id AND i.promoted_seq IS NULL)
      AND NOT EXISTS (SELECT 1 FROM event e WHERE e.aggregate_id = s.id AND e.type >= 'session.next.' AND e.type < 'session.next/')
      AND EXISTS (SELECT 1 FROM event e WHERE e.aggregate_id = s.id AND e.type >= 'message.' AND e.type < 'message/')
  `)
  const chunk = input.chunk ?? CHUNK
  const deleted = yield* Effect.forEach(candidates, (candidate) =>
    deleteChunked(
      db,
      (limit) => sql`DELETE FROM event WHERE rowid IN (
        SELECT rowid FROM event
        WHERE aggregate_id = ${candidate.id} AND type >= 'message.' AND type < 'message/'
        LIMIT ${limit})`,
      chunk,
    ),
  )
  return { sessions: deleted.filter((count) => count > 0).length, events: deleted.reduce((sum, n) => sum + n, 0) }
})

// One short transaction per chunk so the write lock is never held for long;
// the app already sees "database is locked" under concurrent startup writes.
export const deleteChunked = Effect.fnUntraced(function* (db: Db, statement: (limit: number) => SQL, chunk: number) {
  let total = 0
  while (true) {
    const changed = yield* db.transaction((tx) =>
      tx.run(statement(chunk)).pipe(
        Effect.andThen(tx.get<{ n: number }>(sql`SELECT changes() AS n`)),
        Effect.map((row) => row?.n ?? 0),
      ),
    )
    total += changed
    if (changed < chunk) return total
    yield* Effect.yieldNow
  }
})
