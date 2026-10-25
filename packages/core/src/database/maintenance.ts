export * as DatabaseMaintenance from "./maintenance"

import { mkdir, rm, statfs } from "node:fs/promises"
import path from "path"
import { sql, type SQL } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
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
  const freelist = db
    .get<{ freelist_count: number }>(sql`PRAGMA freelist_count`)
    .pipe(Effect.map((row) => row?.freelist_count ?? 0))
  let freed = 0
  let free = yield* freelist
  while (free > 0) {
    // db.all steps the pragma to completion; incremental_vacuum frees pages per step.
    yield* db.all(sql.raw(`PRAGMA incremental_vacuum(${pages})`))
    const after = yield* freelist
    // No progress means the pragma cannot free more right now; stop instead of spinning.
    if (after >= free) return freed
    freed += free - after
    free = after
    yield* Effect.yieldNow
  }
  return freed
})

// auto_vacuum only takes effect on an existing database through one full
// VACUUM, which rewrites the file. Prune first so the rewrite copies only what
// is kept. VACUUM holds an exclusive lock and blocks the thread (both SQLite
// drivers are synchronous), so it runs at startup, before the server is ready.
// It runs inside the database layer, so no step may fail or die: a failing
// maintenance step must never take down the server, and the next launch retries.
export const compactOnce = Effect.fn("DatabaseMaintenance.compactOnce")(function* (
  db: Db,
  input: { filename: string; now: number; freeBytes?: (directory: string) => Promise<number> },
) {
  if (Flag.OPENCODE_DISABLE_DB_MAINTENANCE) return "disabled" as const
  if (input.filename === ":memory:") return "memory" as const
  return yield* Effect.gen(function* () {
    const mode = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(step("read auto_vacuum"))
    if (mode?.auto_vacuum === 2) return "already" as const
    // Prune over a large legacy event table is the slow part, so the desktop's
    // startup stall timer must be extended before it starts.
    yield* notify("started")
    return yield* rewrite(db, input).pipe(
      Effect.ensuring(
        // In WAL mode the rewritten database (and every pruned page) lands in the
        // WAL; truncate it so it does not stay on disk at full size.
        db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.ignoreCause, Effect.andThen(notify("finished"))),
      ),
    )
  }).pipe(
    Effect.catch((failure) =>
      Effect.logWarning(`skipping one-time database compaction: ${failure.step} failed`, {
        cause: Cause.pretty(failure.cause),
      }).pipe(Effect.as("skipped" as const)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("skipping one-time database compaction: unexpected failure", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as("skipped" as const)),
    ),
  )
})

const rewrite = Effect.fnUntraced(function* (
  db: Db,
  input: { filename: string; now: number; freeBytes?: (directory: string) => Promise<number> },
) {
  yield* pruneIdleSessions(db, { now: input.now }).pipe(step("prune idle sessions"))
  yield* sweepOrphans(db).pipe(step("sweep orphans"))

  // VACUUM needs a temporary copy of what is kept, and in WAL mode the rewritten
  // database also goes through the WAL, so the peak is about twice the kept size.
  const directory = path.dirname(input.filename)
  const kept = yield* db
    .get<{ kept: number }>(
      sql`SELECT (p.page_count - f.freelist_count) * s.page_size AS kept
          FROM pragma_page_count p, pragma_freelist_count f, pragma_page_size s`,
    )
    .pipe(
      Effect.map((row) => row?.kept ?? 0),
      step("measure database"),
    )
  const free = yield* Effect.tryPromise(() => (input.freeBytes ?? diskFree)(directory)).pipe(step("check free disk"))
  if (free < 2 * kept + GIB) {
    yield* Effect.logWarning("skipping one-time database compaction: not enough free disk", { kept, free })
    return "low-disk" as const
  }

  // Keep VACUUM's temporary copy on the database's own disk, never /tmp (a
  // quota-limited tmpfs on the owner's machine).
  const temp = path.join(directory, ".vacuum-tmp")
  yield* Effect.tryPromise(() => mkdir(temp, { recursive: true })).pipe(step("create .vacuum-tmp"))
  yield* db.run(sql.raw(`PRAGMA temp_store_directory = '${temp.replaceAll("'", "''")}'`)).pipe(Effect.ignoreCause)

  const vacuum = yield* db
    .run(sql`PRAGMA auto_vacuum = INCREMENTAL`)
    .pipe(Effect.andThen(db.run(sql`VACUUM`)), Effect.exit)
  yield* Effect.tryPromise(() => rm(temp, { recursive: true, force: true })).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("one-time database compaction: removing .vacuum-tmp failed", { cause: Cause.pretty(cause) }),
    ),
  )
  if (Exit.isFailure(vacuum)) {
    // Setting auto_vacuum without a completed VACUUM leaves the file unchanged;
    // the next launch retries.
    yield* db.run(sql`PRAGMA auto_vacuum = NONE`).pipe(Effect.ignoreCause)
    yield* Effect.logWarning("skipping one-time database compaction: VACUUM failed", {
      cause: Cause.pretty(vacuum.cause),
    })
    return "skipped" as const
  }
  yield* Effect.logInfo("compacted history database to incremental auto_vacuum")
  return "compacted" as const
})

type StepFailure = { step: string; cause: Cause.Cause<unknown> }

// Tags any failure or defect with the step that produced it, so compactOnce can
// log the step and skip instead of failing.
function step(name: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.catchCause((cause) => Effect.fail<StepFailure>({ step: name, cause })))
}

function notify(state: Progress["state"]) {
  return Effect.sync(() => report({ phase: "compact", state })).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("one-time database compaction: progress listener failed", { cause: Cause.pretty(cause) }),
    ),
  )
}

async function diskFree(directory: string) {
  const info = await statfs(directory)
  return info.bavail * info.bsize
}
