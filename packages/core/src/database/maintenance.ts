export * as DatabaseMaintenance from "./maintenance"

import { mkdir, rm, stat, statfs } from "node:fs/promises"
import path from "path"
import { sql, type SQL } from "drizzle-orm"
import { Effect } from "effect"
import { Flag } from "../flag/flag"
import type { Interface } from "./database"

type Db = Interface["db"]

export const IDLE_MS = 7 * 24 * 60 * 60 * 1000
const CHUNK = 2_000
const RECLAIM_PAGES = 10_000
const GIB = 1024 * 1024 * 1024

export type Progress = { phase: "compact"; state: "started" | "finished" }

// Set by the process entry (the desktop sidecar forwards it so its startup
// stall timer does not kill the server mid-VACUUM). Without a listener the
// CLI prints one line, since startup is slower that one time.
let progressListener: ((progress: Progress) => void) | undefined
export function onProgress(listener: ((progress: Progress) => void) | undefined) {
  progressListener = listener
}
function report(progress: Progress) {
  if (progressListener) return progressListener(progress)
  if (progress.state === "started") process.stderr.write("Optimizing history database (one-time)…\n")
}

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
      // Eligibility is re-checked in every chunk: the hourly pass runs beside a live
      // server, so a session can be resumed between selection and deletion.
      (limit) => sql`DELETE FROM event WHERE rowid IN (
        SELECT rowid FROM event
        WHERE aggregate_id = ${candidate.id} AND type >= 'message.' AND type < 'message/'
          AND EXISTS (
            SELECT 1 FROM session s
            JOIN event_sequence q ON q.aggregate_id = s.id
            WHERE s.id = ${candidate.id}
              AND s.time_updated < ${cutoff}
              AND q.owner_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM session_input i WHERE i.session_id = s.id AND i.promoted_seq IS NULL))
        LIMIT ${limit})`,
      chunk,
    ),
  )
  return { sessions: deleted.filter((count) => count > 0).length, events: deleted.reduce((sum, n) => sum + n, 0) }
})

// Session.remove deletes the session row, then its events; if it dies in
// between, the events stay forever. Session creation commits the event and
// the session row in one transaction, so an aggregate without a session row
// is never a session that is still being created.
export const sweepOrphans = Effect.fn("DatabaseMaintenance.sweepOrphans")(function* (
  db: Db,
  input?: { chunk?: number },
) {
  const orphans = yield* db.all<{ id: string }>(sql`
    SELECT q.aggregate_id AS id FROM event_sequence q
    WHERE q.aggregate_id LIKE 'ses\\_%' ESCAPE '\\'
      AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = q.aggregate_id)
  `)
  const chunk = input?.chunk ?? CHUNK
  const events = yield* Effect.forEach(orphans, (orphan) =>
    deleteChunked(
      db,
      (limit) => sql`DELETE FROM event WHERE rowid IN (
        SELECT rowid FROM event WHERE aggregate_id = ${orphan.id} LIMIT ${limit})`,
      chunk,
    ).pipe(Effect.tap(() => db.run(sql`DELETE FROM event_sequence WHERE aggregate_id = ${orphan.id}`))),
  )
  return { aggregates: orphans.length, events: events.reduce((sum, n) => sum + n, 0) }
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

export const reclaim = Effect.fn("DatabaseMaintenance.reclaim")(function* (db: Db, input?: { pages?: number }) {
  const mode = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`)
  if (mode?.auto_vacuum !== 2) return 0
  const pages = input?.pages ?? RECLAIM_PAGES
  let freed = 0
  while (true) {
    const free = (yield* db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`))?.freelist_count ?? 0
    if (free === 0) return freed
    // db.all steps the pragma to completion; incremental_vacuum frees pages per step.
    yield* db.all(sql.raw(`PRAGMA incremental_vacuum(${pages})`))
    freed += Math.min(free, pages)
    yield* Effect.yieldNow
  }
})

// auto_vacuum only takes effect on an existing database through one full
// VACUUM, which rewrites the file. Prune first so the rewrite copies only what
// is kept. VACUUM holds an exclusive lock and blocks the thread (both SQLite
// drivers are synchronous), so it runs at startup, before the server is ready.
export const compactOnce = Effect.fn("DatabaseMaintenance.compactOnce")(function* (
  db: Db,
  input: { filename: string; now: number; freeBytes?: (directory: string) => Promise<number> },
) {
  if (Flag.OPENCODE_DISABLE_DB_MAINTENANCE) return "disabled" as const
  if (input.filename === ":memory:") return "memory" as const
  const mode = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
  if (mode?.auto_vacuum === 2) return "already" as const

  yield* pruneIdleSessions(db, { now: input.now }).pipe(Effect.orDie)
  yield* sweepOrphans(db).pipe(Effect.orDie)

  const directory = path.dirname(input.filename)
  const size = yield* Effect.promise(async () => {
    const sizes = await Promise.all(
      [input.filename, `${input.filename}-wal`].map((file) =>
        stat(file).then(
          (info) => info.size,
          () => 0,
        ),
      ),
    )
    return sizes.reduce((sum, n) => sum + n, 0)
  })
  const free = yield* Effect.promise(() => (input.freeBytes ?? diskFree)(directory))
  if (free < size + GIB) {
    yield* Effect.logWarning("skipping one-time database compaction: not enough free disk", { size, free })
    return "low-disk" as const
  }

  // VACUUM writes a temporary copy about the size of the database; keep it on
  // the database's own disk, never /tmp (a quota-limited tmpfs on the owner's machine).
  const temp = path.join(directory, ".vacuum-tmp")
  yield* Effect.promise(() => mkdir(temp, { recursive: true }))
  process.env.SQLITE_TMPDIR = temp
  yield* db.run(sql.raw(`PRAGMA temp_store_directory = '${temp.replaceAll("'", "''")}'`)).pipe(Effect.ignore)

  report({ phase: "compact", state: "started" })
  const result = yield* db
    .run(sql`PRAGMA auto_vacuum = INCREMENTAL`)
    .pipe(Effect.andThen(db.run(sql`VACUUM`)), Effect.result)
  report({ phase: "compact", state: "finished" })
  yield* Effect.promise(() => rm(temp, { recursive: true, force: true }))
  if (result._tag === "Failure") {
    // Setting auto_vacuum without a completed VACUUM leaves the file unchanged;
    // the next launch retries.
    yield* db.run(sql`PRAGMA auto_vacuum = NONE`).pipe(Effect.ignore)
    yield* Effect.logWarning("skipping one-time database compaction: VACUUM failed", { cause: String(result.failure) })
    return "skipped" as const
  }
  yield* Effect.logInfo("compacted history database to incremental auto_vacuum")
  return "compacted" as const
})

async function diskFree(directory: string) {
  const info = await statfs(directory)
  return info.bavail * info.bsize
}
