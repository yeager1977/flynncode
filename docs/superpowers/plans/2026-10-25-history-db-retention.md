# History DB Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Flynncode's history database from growing forever: prune redundant event rows of idle classic sessions, sweep orphans, and reclaim disk space automatically.

**Architecture:** Pure maintenance functions in `packages/core/src/database/maintenance.ts` take the Drizzle `db` handle. `Database.layerFromPath` runs a one-time compaction to `auto_vacuum = INCREMENTAL` after migrations. A global node in `maintenance-node.ts` runs an hourly pass (prune → orphan sweep → incremental reclaim). The flynncode server adds an hourly `session_diff` file sweep. The desktop sidecar forwards compaction start/finish so the startup stall timer does not kill the server mid-`VACUUM`.

**Tech Stack:** TypeScript, Effect 4 beta, drizzle-orm `sql` templates over `EffectDrizzleSqlite` (`db.run` / `db.all<T>` / `db.get<T>` / `db.transaction`), SQLite via `node:sqlite` (desktop) and `bun:sqlite` (CLI/tests), bun test.

**Spec:** `docs/superpowers/specs/2026-10-25-history-db-retention-design.md`

## Global Constraints

- Idle threshold: 7 days (`session.time_updated` older than `now - 7 days`, milliseconds).
- Prunable event types: `type >= 'message.' AND type < 'message/'` (all `message.*` incl. `message.part.*`). Never delete `session.*` events. Never touch `event_sequence` rows of live sessions.
- Never prune: sessions with `session_message` rows, `session.next.*` events, pending `session_input` (`promoted_seq IS NULL`), or a non-null `event_sequence.owner_id`.
- Delete chunk size: 2,000 rows, one short transaction per chunk, `Effect.yieldNow` between chunks.
- Reclaim step: `PRAGMA incremental_vacuum(10000)` until `freelist_count` is 0.
- Compaction skip: free bytes on the DB's filesystem < DB file size + WAL size + 1 GiB, or `VACUUM` fails (busy). Log and continue; retry next launch.
- `VACUUM` temp files go under `<db dir>/.vacuum-tmp`, never `/tmp`.
- Opt-out flag: `OPENCODE_DISABLE_DB_MAINTENANCE` (in `packages/core/src/flag/flag.ts`).
- Repo style (AGENTS.md): no `any`, no import aliases or star imports, `const` over `let` where practical, no `else`, Effect services bound to variables, comments only for non-obvious constraints. Run tests from package dirs, `bun typecheck` from package dirs.
- Stage explicit paths only (shared checkout); never `git add -A`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Prune idle classic sessions

**Files:**
- Create: `packages/core/src/database/maintenance.ts`
- Create: `packages/core/test/database-maintenance.test.ts`
- Modify: `packages/core/src/flag/flag.ts` (add flag next to `OPENCODE_DISABLE_PRUNE`)

**Interfaces:**
- Produces:
  - `type Db = Database.Interface["db"]` (type-only import from `./database`, to avoid a runtime import cycle).
  - `DatabaseMaintenance.IDLE_MS: number` (7 days).
  - `DatabaseMaintenance.pruneIdleSessions(db: Db, input: { now: number; idleMs?: number; chunk?: number }): Effect<{ sessions: number; events: number }, SqlError>`
  - internal `deleteChunked(db: Db, statement: (chunk: number) => SQL, chunk: number): Effect<number, SqlError>` — reused by Task 2.
  - `Flag.OPENCODE_DISABLE_DB_MAINTENANCE: boolean`

- [ ] **Step 1: Add the flag**

In `packages/core/src/flag/flag.ts`, directly after `OPENCODE_DISABLE_PRUNE: truthy("OPENCODE_DISABLE_PRUNE"),` add:

```ts
  OPENCODE_DISABLE_DB_MAINTENANCE: truthy("OPENCODE_DISABLE_DB_MAINTENANCE"),
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/database-maintenance.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import path from "path"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "@flynncode/core/database/database"
import { DatabaseMaintenance } from "@flynncode/core/database/maintenance"
import { tmpdir } from "./fixture/tmpdir"

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

type Db = Database.Interface["db"]

// Opens a real migrated database file and runs `fn` against it.
const withDb = <A>(fn: (db: Db, filename: string) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const filename = path.join(tmp.path, "history.db")
      const context = yield* Layer.build(Database.layerFromPath(filename))
      return yield* fn(Context.get(context, Database.Service).db, filename)
    }).pipe(Effect.scoped),
  )

const seedProject = (db: Db) =>
  db.run(sql`INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated)
             VALUES ('prj_test', '/repo', '[]', ${NOW}, ${NOW})`)

// A classic session with `messages` message.* events and one session.created event.
const seedSession = (db: Db, input: { id: string; updated: number; messages: number; owner?: string }) =>
  Effect.gen(function* () {
    yield* seedProject(db)
    yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                      VALUES (${input.id}, 'prj_test', ${input.id}, '/repo', 't', '1', ${input.updated}, ${input.updated})`)
    yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id)
                      VALUES (${input.id}, ${input.messages}, ${input.owner ?? null})`)
    yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data)
                      VALUES (${`evt_${input.id}_0`}, ${input.id}, 0, 'session.created.1', '{}')`)
    for (let seq = 1; seq <= input.messages; seq++)
      yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data)
                        VALUES (${`evt_${input.id}_${seq}`}, ${input.id}, ${seq},
                                ${seq % 2 === 0 ? "message.updated.1" : "message.part.updated.1"}, '{}')`)
  })

const eventTypes = (db: Db, id: string) =>
  db
    .all<{ type: string }>(sql`SELECT type FROM event WHERE aggregate_id = ${id} ORDER BY seq`)
    .pipe(Effect.map((rows) => rows.map((row) => row.type)))

describe("DatabaseMaintenance.pruneIdleSessions", () => {
  test("drops message events of a classic session idle for 7 days and keeps the rest", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_idle", updated: NOW - 8 * DAY, messages: 5 })
        const pruned = yield* DatabaseMaintenance.pruneIdleSessions(db, { now: NOW, chunk: 2 })
        const sequence = yield* db.get<{ seq: number }>(
          sql`SELECT seq FROM event_sequence WHERE aggregate_id = 'ses_idle'`,
        )
        return { pruned, types: yield* eventTypes(db, "ses_idle"), sequence }
      }),
    )
    expect(result.pruned).toEqual({ sessions: 1, events: 5 })
    expect(result.types).toEqual(["session.created.1"])
    // The counter survives, so a resumed session appends at seq + 1.
    expect(result.sequence?.seq).toBe(5)
  })

  test("leaves recent, v2, pending-input and owned sessions untouched", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_recent", updated: NOW - 2 * DAY, messages: 2 })
        yield* seedSession(db, { id: "ses_owned", updated: NOW - 8 * DAY, messages: 2, owner: "proc_1" })
        yield* seedSession(db, { id: "ses_v2", updated: NOW - 8 * DAY, messages: 2 })
        yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data)
                          VALUES ('evt_ses_v2_next', 'ses_v2', 3, 'session.next.prompted.1', '{}')`)
        yield* seedSession(db, { id: "ses_input", updated: NOW - 8 * DAY, messages: 2 })
        yield* db.run(sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created)
                          VALUES ('msg_pending', 'ses_input', '{}', 'steer', 1, ${NOW})`)
        const pruned = yield* DatabaseMaintenance.pruneIdleSessions(db, { now: NOW })
        return {
          pruned,
          counts: yield* db.all<{ aggregate_id: string; n: number }>(
            sql`SELECT aggregate_id, count(*) AS n FROM event GROUP BY aggregate_id ORDER BY aggregate_id`,
          ),
        }
      }),
    )
    expect(result.pruned).toEqual({ sessions: 0, events: 0 })
    expect(result.counts).toEqual([
      { aggregate_id: "ses_input", n: 3 },
      { aggregate_id: "ses_owned", n: 3 },
      { aggregate_id: "ses_recent", n: 3 },
      { aggregate_id: "ses_v2", n: 4 },
    ])
  })
})
```

Note for the implementer: `Context.get(context, Database.Service)` mirrors `packages/flynncode/src/server/server.ts` (`Context.get(ctx, HttpServer.HttpServer)`). If an `INSERT` fails on a NOT NULL column you did not expect, read the table in `packages/core/src/session/sql.ts` / `packages/core/src/project/sql.ts` and add that column with a literal value.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/core && bun test test/database-maintenance.test.ts`
Expected: FAIL — cannot resolve `@flynncode/core/database/maintenance`.

- [ ] **Step 4: Implement**

Create `packages/core/src/database/maintenance.ts`:

```ts
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
```

- [ ] **Step 5: Run tests**

Run: `cd packages/core && bun test test/database-maintenance.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Typecheck and commit**

Run: `cd packages/core && bun typecheck` — expected: no errors.

```bash
git add packages/core/src/database/maintenance.ts packages/core/test/database-maintenance.test.ts packages/core/src/flag/flag.ts
git commit -m "feat(core): prune message events of idle classic sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Sweep orphaned session aggregates

**Files:**
- Modify: `packages/core/src/database/maintenance.ts`
- Modify: `packages/core/test/database-maintenance.test.ts`

**Interfaces:**
- Consumes: `deleteChunked`, test helpers `withDb`, `seedSession`, `eventTypes` from Task 1.
- Produces: `DatabaseMaintenance.sweepOrphans(db: Db, input?: { chunk?: number }): Effect<{ aggregates: number; events: number }, SqlError>`

- [ ] **Step 1: Write the failing test** — append to `database-maintenance.test.ts`:

```ts
describe("DatabaseMaintenance.sweepOrphans", () => {
  test("removes events of a session row that no longer exists and keeps live ones", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_live", updated: NOW, messages: 3 })
        yield* seedSession(db, { id: "ses_gone", updated: NOW, messages: 3 })
        // A delete that died between the session row and its events.
        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_gone'`)
        const swept = yield* DatabaseMaintenance.sweepOrphans(db, { chunk: 2 })
        return {
          swept,
          live: yield* eventTypes(db, "ses_live"),
          gone: yield* eventTypes(db, "ses_gone"),
          sequences: yield* db.all<{ aggregate_id: string }>(sql`SELECT aggregate_id FROM event_sequence`),
        }
      }),
    )
    expect(result.swept).toEqual({ aggregates: 1, events: 4 })
    expect(result.live).toHaveLength(4)
    expect(result.gone).toEqual([])
    expect(result.sequences).toEqual([{ aggregate_id: "ses_live" }])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && bun test test/database-maintenance.test.ts -t sweepOrphans`
Expected: FAIL — `sweepOrphans` is not a function.

- [ ] **Step 3: Implement** — add to `maintenance.ts` after `pruneIdleSessions`:

```ts
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
```

Check the escape: in the emitted SQL the pattern must read `'ses\_%' ESCAPE '\'`. In a JS template literal `\\` emits one backslash, so the source above is correct; verify by the test passing with an aggregate named like `sesXfoo` NOT being matched (optional extra assertion).

- [ ] **Step 4: Run tests** — `cd packages/core && bun test test/database-maintenance.test.ts` → 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/database/maintenance.ts packages/core/test/database-maintenance.test.ts
git commit -m "feat(core): sweep events of deleted sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Incremental reclaim and the one-time compaction

**Files:**
- Modify: `packages/core/src/database/maintenance.ts`
- Modify: `packages/core/src/database/database.ts`
- Modify: `packages/core/test/database-maintenance.test.ts`

**Interfaces:**
- Consumes: `pruneIdleSessions`, `sweepOrphans`.
- Produces:
  - `type Progress = { phase: "compact"; state: "started" | "finished" }`
  - `DatabaseMaintenance.onProgress(listener: ((progress: Progress) => void) | undefined): void` — used by the flynncode server in Task 5.
  - `DatabaseMaintenance.reclaim(db: Db, input?: { pages?: number }): Effect<number, SqlError>` — pages freed; 0 when not incremental.
  - `DatabaseMaintenance.compactOnce(db: Db, input: { filename: string; now: number; freeBytes?: (directory: string) => Promise<number> }): Effect<"disabled" | "memory" | "already" | "low-disk" | "skipped" | "compacted">`
  - `Database.layerFromPath(filename)` now runs `compactOnce` after migrations.

- [ ] **Step 1: Write the failing tests** — append:

```ts
const autoVacuum = (db: Db) =>
  db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.map((row) => row?.auto_vacuum))

describe("DatabaseMaintenance compaction", () => {
  test("a new database starts in incremental mode, so compaction is a no-op", async () => {
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        return {
          mode: yield* autoVacuum(db),
          compact: yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW }),
        }
      }),
    )
    expect(result).toEqual({ mode: 2, compact: "already" })
  })

  test("converts a legacy database once and frees pruned pages", async () => {
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        // Simulate a pre-maintenance database: auto_vacuum NONE.
        yield* db.run(sql`PRAGMA auto_vacuum = NONE`)
        yield* db.run(sql`VACUUM`)
        yield* seedSession(db, { id: "ses_big", updated: NOW - 8 * DAY, messages: 400 })
        yield* db.run(sql`UPDATE event SET data = json_object('pad', hex(randomblob(2000)))`)
        const before = yield* autoVacuum(db)
        const first = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW })
        const second = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW })
        yield* seedSession(db, { id: "ses_more", updated: NOW - 8 * DAY, messages: 400 })
        yield* db.run(sql`UPDATE event SET data = json_object('pad', hex(randomblob(2000))) WHERE aggregate_id = 'ses_more'`)
        yield* DatabaseMaintenance.pruneIdleSessions(db, { now: NOW })
        const freeBefore = (yield* db.get<{ n: number }>(sql`SELECT freelist_count AS n FROM pragma_freelist_count`))?.n
        const freed = yield* DatabaseMaintenance.reclaim(db)
        const freeAfter = (yield* db.get<{ n: number }>(sql`SELECT freelist_count AS n FROM pragma_freelist_count`))?.n
        return { before, after: yield* autoVacuum(db), first, second, freeBefore, freed, freeAfter }
      }),
    )
    expect(result.before).toBe(0)
    expect(result.after).toBe(2)
    expect(result.first).toBe("compacted")
    expect(result.second).toBe("already")
    expect(result.freeBefore).toBeGreaterThan(0)
    expect(result.freed).toBeGreaterThan(0)
    expect(result.freeAfter).toBe(0)
  })

  test("skips compaction when the disk is too full", async () => {
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* db.run(sql`PRAGMA auto_vacuum = NONE`)
        yield* db.run(sql`VACUUM`)
        const compact = yield* DatabaseMaintenance.compactOnce(db, {
          filename,
          now: NOW,
          freeBytes: async () => 1024,
        })
        return { compact, mode: yield* autoVacuum(db) }
      }),
    )
    expect(result).toEqual({ compact: "low-disk", mode: 0 })
  })

  test("skips compaction while another connection holds the database", async () => {
    const { Database: BunDatabase } = await import("bun:sqlite")
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* db.run(sql`PRAGMA auto_vacuum = NONE`)
        yield* db.run(sql`VACUUM`)
        yield* db.run(sql`PRAGMA busy_timeout = 100`)
        const other = new BunDatabase(filename)
        other.run("BEGIN")
        other.query("SELECT count(*) FROM session").get()
        const compact = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW })
        other.run("COMMIT")
        other.close()
        return { compact, mode: yield* autoVacuum(db) }
      }),
    )
    expect(result).toEqual({ compact: "skipped", mode: 0 })
  })
})
```

Note: `pragma_freelist_count` table-valued function form is used so `db.get` returns a named column; if the bundled SQLite rejects it, use `db.get<{ freelist_count: number }>(sql\`PRAGMA freelist_count\`)`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/core && bun test test/database-maintenance.test.ts -t compaction`
Expected: FAIL — `compactOnce` is not a function (and the first test fails on mode 0 until Step 4).

- [ ] **Step 3: Implement in `maintenance.ts`** — add imports and functions:

```ts
import { mkdir, rm, stat, statfs } from "node:fs/promises"
import path from "path"
import { Flag } from "../flag/flag"
```

```ts
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
      [input.filename, `${input.filename}-wal`].map((file) => stat(file).then((info) => info.size, () => 0)),
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
  const result = yield* db.run(sql`PRAGMA auto_vacuum = INCREMENTAL`).pipe(
    Effect.andThen(db.run(sql`VACUUM`)),
    Effect.result,
  )
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
```

Note for the implementer: if `Effect.result` is not the Effect 4 beta name in this repo, find the equivalent used elsewhere (`grep -rn "Effect.result" packages/flynncode/src | head`; the flynncode auth test in commit 835f9c3495 uses `Effect.result` and checks `_tag === "Failure"`).

- [ ] **Step 4: Wire into `database.ts`**

In `packages/core/src/database/database.ts`:

1. Add `import { DatabaseMaintenance } from "./maintenance"`.
2. Turn `const layer = Layer.effect(...)` into `const layer = (filename: string) => Layer.effect(...)`.
3. Inside it, set incremental mode before migrations (it takes effect without a VACUUM only on a brand-new file that has no tables yet), then compact after migrations:

```ts
    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    // Only takes effect on a new, empty file; existing files convert in compactOnce.
    yield* db.run("PRAGMA auto_vacuum = INCREMENTAL")
    yield* DatabaseMigration.apply(db)
    yield* DatabaseMaintenance.compactOnce(db, { filename, now: Date.now() })
```

4. In `layerFromPath`, pass the filename: `layer(filename).pipe(Layer.provide(sqliteLayer({ filename })))` in both branches.

`PRAGMA auto_vacuum = INCREMENTAL` must run before `journal_mode = WAL` creates any page on a new file? It does not: WAL mode switch does not create tables. If the new-database test (mode 2) fails, move the `auto_vacuum` pragma to be the first statement after `makeDatabase`.

- [ ] **Step 5: Run tests**

Run: `cd packages/core && bun test test/database-maintenance.test.ts test/database-migration.test.ts test/database-permissions.test.ts`
Expected: all pass.

- [ ] **Step 6: Typecheck and commit**

Run: `cd packages/core && bun typecheck`

```bash
git add packages/core/src/database/maintenance.ts packages/core/src/database/database.ts packages/core/test/database-maintenance.test.ts
git commit -m "feat(core): convert the history database to incremental auto_vacuum once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Hourly maintenance node

**Files:**
- Create: `packages/core/src/database/maintenance-node.ts`
- Modify: `packages/flynncode/src/server/routes/instance/httpapi/server.ts` (add to `app` group after `Database.node`)
- Modify: `packages/server/src/routes.ts` (add to `applicationServices` after `ToolOutputStore.cleanupNode`)
- Modify: `packages/core/test/database-maintenance.test.ts`

**Interfaces:**
- Consumes: `pruneIdleSessions`, `sweepOrphans`, `reclaim`.
- Produces: `DatabaseMaintenanceNode.pass(db: Db, now: number): Effect<{ pruned; orphans; freed }, SqlError>`, `DatabaseMaintenanceNode.node` (global node).

- [ ] **Step 1: Failing test** — append:

```ts
import { DatabaseMaintenanceNode } from "@flynncode/core/database/maintenance-node"

describe("DatabaseMaintenanceNode.pass", () => {
  test("prunes, sweeps and reclaims in one pass", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_idle", updated: NOW - 8 * DAY, messages: 3 })
        yield* seedSession(db, { id: "ses_gone", updated: NOW, messages: 2 })
        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_gone'`)
        return yield* DatabaseMaintenanceNode.pass(db, NOW)
      }),
    )
    expect(result.pruned).toEqual({ sessions: 1, events: 3 })
    expect(result.orphans).toEqual({ aggregates: 1, events: 3 })
    expect(result.freed).toBeGreaterThanOrEqual(0)
  })
})
```

(Move the new import to the top of the file with the other imports.)

- [ ] **Step 2: Run** — `cd packages/core && bun test test/database-maintenance.test.ts -t pass` → FAIL (module missing).

- [ ] **Step 3: Implement** `packages/core/src/database/maintenance-node.ts`:

```ts
export * as DatabaseMaintenanceNode from "./maintenance-node"

import { Cause, Duration, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Flag } from "../flag/flag"
import { Database } from "./database"
import { DatabaseMaintenance } from "./maintenance"

type Db = Database.Interface["db"]

export const pass = Effect.fn("DatabaseMaintenance.pass")(function* (db: Db, now: number) {
  const started = Date.now()
  const pruned = yield* DatabaseMaintenance.pruneIdleSessions(db, { now })
  const orphans = yield* DatabaseMaintenance.sweepOrphans(db)
  const freed = yield* DatabaseMaintenance.reclaim(db)
  yield* Effect.logInfo("database maintenance pass", {
    sessions: pruned.sessions,
    events: pruned.events,
    orphanAggregates: orphans.aggregates,
    orphanEvents: orphans.events,
    reclaimedMB: Math.round((freed * 4096) / 1048576),
    ms: Date.now() - started,
  })
  return { pruned, orphans, freed }
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (Flag.OPENCODE_DISABLE_DB_MAINTENANCE) return
    const database = yield* Database.Service
    // A failed pass (e.g. SQLITE_BUSY after busy_timeout) is logged and the
    // next hourly pass retries; every step is safe to repeat.
    yield* Effect.suspend(() => pass(database.db, Date.now())).pipe(
      Effect.catchCause((cause) => Effect.logError("database maintenance failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )
  }),
)

export const node = makeGlobalNode({ name: "database-maintenance", layer, deps: [Database.node] })
```

Register it:
- `packages/flynncode/src/server/routes/instance/httpapi/server.ts`: `import { DatabaseMaintenanceNode } from "@flynncode/core/database/maintenance-node"` and add `DatabaseMaintenanceNode.node,` right after `Database.node,` in `export const app = LayerNode.group([...])`.
- `packages/server/src/routes.ts`: same import, add `DatabaseMaintenanceNode.node,` after `ToolOutputStore.cleanupNode,`.

Check that `makeGlobalNode({ name, layer, deps })` without `service` is valid — `ToolOutputStore.cleanupNode` and `SessionProjector.node` (`core/src/session/projector.ts:473`) use that form.

- [ ] **Step 4: Run tests and typecheck**

```bash
cd packages/core && bun test test/database-maintenance.test.ts && bun typecheck
cd ../flynncode && bun typecheck
cd ../server && bun typecheck
```
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/database/maintenance-node.ts packages/core/test/database-maintenance.test.ts packages/flynncode/src/server/routes/instance/httpapi/server.ts packages/server/src/routes.ts
git commit -m "feat(core): run database maintenance hourly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sweep orphaned session_diff files

**Files:**
- Create: `packages/flynncode/src/storage/session-diff-sweep.ts`
- Create: `packages/flynncode/test/storage/session-diff-sweep.test.ts`
- Modify: `packages/flynncode/src/server/routes/instance/httpapi/server.ts` (register node)

**Interfaces:**
- Consumes: `Storage.Service` (`list(prefix: string[]): Effect<string[][]>`, `remove(key: string[])`, `write(key, content)`), `Database.Service`.
- Produces: `SessionDiffSweep.sweep(): Effect<number>` (files removed), `SessionDiffSweep.node`.

- [ ] **Step 1: Failing test** — first read an existing flynncode test that uses `Storage` and `Database` with `testEffect` (e.g. `grep -rln "Storage.Service" packages/flynncode/test | head -3`) and mirror its layer setup. Test body:

```ts
import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { Storage } from "../../src/storage/storage"
import { SessionDiffSweep } from "../../src/storage/session-diff-sweep"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, Database.node, SessionDiffSweep.node])))

describe("SessionDiffSweep", () => {
  it.instance("removes session_diff files of deleted sessions only", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      yield* database.db.run(sql`INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated)
                                 VALUES ('prj_sweep', '/repo', '[]', 1, 1)`)
      yield* database.db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                                 VALUES ('ses_kept', 'prj_sweep', 'k', '/repo', 't', '1', 1, 1)`)
      yield* storage.write(["session_diff", "ses_kept"], [])
      yield* storage.write(["session_diff", "ses_gone"], [])
      const sweep = yield* SessionDiffSweep.Service
      const removed = yield* sweep.sweep()
      const left = (yield* storage.list(["session_diff"])).map((key) => key.at(-1))
      expect(removed).toBe(1)
      expect(left).toEqual(["ses_kept"])
    }),
  )
})
```

- [ ] **Step 2: Run** — `cd packages/flynncode && bun test test/storage/session-diff-sweep.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `packages/flynncode/src/storage/session-diff-sweep.ts`:

```ts
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Layer, Schedule } from "effect"
import { Storage } from "./storage"

export interface Interface {
  readonly sweep: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/SessionDiffSweep") {}

// session/revert.ts writes storage/session_diff/<sessionID>.json and nothing
// removes it when the session is deleted. Core's database maintenance cannot
// see this server-owned storage, so it gets its own hourly sweep.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    const sweep = Effect.fn("SessionDiffSweep.sweep")(function* () {
      const keys = yield* storage.list(["session_diff"]).pipe(Effect.orElseSucceed(() => []))
      if (keys.length === 0) return 0
      const live = new Set(
        (yield* database.db.all<{ id: string }>(sql`SELECT id FROM session`).pipe(Effect.orDie)).map((row) => row.id),
      )
      const stale = keys.filter((key) => !live.has(key.at(-1) ?? ""))
      yield* Effect.forEach(stale, (key) => storage.remove(key).pipe(Effect.ignore), { discard: true })
      return stale.length
    })
    yield* sweep().pipe(
      Effect.catchCause((cause) => Effect.logError("session diff sweep failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )
    return Service.of({ sweep })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Storage.node, Database.node] })

export * as SessionDiffSweep from "./session-diff-sweep"
```

Register: in `packages/flynncode/src/server/routes/instance/httpapi/server.ts` import `{ SessionDiffSweep } from "@/storage/session-diff-sweep"` and add `SessionDiffSweep.node,` after `Storage.node,` in the `app` group.

- [ ] **Step 4: Run tests and typecheck** — `cd packages/flynncode && bun test test/storage/session-diff-sweep.test.ts && bun typecheck` → pass.

- [ ] **Step 5: Commit**

```bash
git add packages/flynncode/src/storage/session-diff-sweep.ts packages/flynncode/test/storage/session-diff-sweep.test.ts packages/flynncode/src/server/routes/instance/httpapi/server.ts
git commit -m "feat(flynncode): sweep session_diff files of deleted sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Keep the desktop sidecar alive during compaction

**Files:**
- Modify: `packages/flynncode/src/server/server.ts` (`ListenOptions` + `listen`)
- Create: `packages/desktop/src/main/sidecar-maintenance.ts`
- Create: `packages/desktop/src/main/sidecar-maintenance.test.ts`
- Modify: `packages/desktop/src/main/sidecar.ts` (message type + pass listener)
- Modify: `packages/desktop/src/main/server.ts` (message type + stall timer)

**Interfaces:**
- Consumes: `DatabaseMaintenance.onProgress(listener)` and `Progress` from Task 3.
- Produces: `ListenOptions.onMaintenance?: (progress: DatabaseMaintenance.Progress) => void`; desktop `stallTimeoutFor(message: { type: string; phase?: string; state?: string }): number`.

- [ ] **Step 1: Failing test** — `packages/desktop/src/main/sidecar-maintenance.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { SIDECAR_MAINTENANCE_TIMEOUT, SIDECAR_START_STALL_TIMEOUT, stallTimeoutFor } from "./sidecar-maintenance"

describe("stallTimeoutFor", () => {
  test("allows a long one-time compaction once it starts", () => {
    expect(stallTimeoutFor({ type: "maintenance", phase: "compact", state: "started" })).toBe(
      SIDECAR_MAINTENANCE_TIMEOUT,
    )
  })

  test("returns to the normal stall timeout when compaction finishes", () => {
    expect(stallTimeoutFor({ type: "maintenance", phase: "compact", state: "finished" })).toBe(
      SIDECAR_START_STALL_TIMEOUT,
    )
  })

  test("keeps the normal timeout for other messages", () => {
    expect(stallTimeoutFor({ type: "sync-status" })).toBe(SIDECAR_START_STALL_TIMEOUT)
  })
})
```

- [ ] **Step 2: Run** — `cd packages/desktop && bun test src/main/sidecar-maintenance.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `packages/desktop/src/main/sidecar-maintenance.ts`:

```ts
export const SIDECAR_START_STALL_TIMEOUT = 60_000
// The server converts a large history database once (a full VACUUM, minutes
// on a 13GB file). It blocks the sidecar thread, so no heartbeat can arrive
// until it finishes; allow it this long before treating startup as stalled.
export const SIDECAR_MAINTENANCE_TIMEOUT = 30 * 60_000

export function stallTimeoutFor(message: { type: string; phase?: string; state?: string }) {
  if (message.type === "maintenance" && message.phase === "compact" && message.state === "started")
    return SIDECAR_MAINTENANCE_TIMEOUT
  return SIDECAR_START_STALL_TIMEOUT
}
```

- [ ] **Step 4: Wire the server option** — in `packages/flynncode/src/server/server.ts`:

```ts
import { DatabaseMaintenance } from "@flynncode/core/database/maintenance"
```

Add to `ListenOptions`: `onMaintenance?: (progress: DatabaseMaintenance.Progress) => void`. At the top of `export async function listen(opts)`, before `Effect.runPromise(...)`:

```ts
  if (opts.onMaintenance) DatabaseMaintenance.onProgress(opts.onMaintenance)
```

- [ ] **Step 5: Wire the sidecar** — in `packages/desktop/src/main/sidecar.ts`:
  - Extend `type SidecarMessage` with `| { type: "maintenance"; phase: "compact"; state: "started" | "finished" }`.
  - In `start`, pass to `Server.listen({...})`: `onMaintenance: (progress) => parentPort.postMessage({ type: "maintenance", ...progress }),`

- [ ] **Step 6: Wire the main-process timer** — in `packages/desktop/src/main/server.ts`:
  - Delete the local `const SIDECAR_START_STALL_TIMEOUT = 60_000` and `import { SIDECAR_START_STALL_TIMEOUT, stallTimeoutFor } from "./sidecar-maintenance"`.
  - Extend `type SidecarMessage` with the same `maintenance` variant.
  - Change `refreshTimeout` to take a duration: `const refreshTimeout = (ms = SIDECAR_START_STALL_TIMEOUT) => { clearTimeout(timeout); timeout = setTimeout(() => fail(new Error(\`Sidecar did not become ready within ${ms}ms: ${sidecar}\`)), ms) }`.
  - At the top of `onMessage`:

```ts
      if (message.type === "maintenance") {
        logger.log("sidecar database maintenance", { phase: message.phase, state: message.state })
        refreshTimeout(stallTimeoutFor(message))
        return
      }
```

  (Use the logger that `server.ts` already uses; if none is in scope, use `console.log` with the same message, matching how this file logs elsewhere.)

- [ ] **Step 7: Run tests and typecheck**

```bash
cd packages/desktop && bun test src/main/sidecar-maintenance.test.ts src/main/sidecar-args.test.ts && bun typecheck
cd ../flynncode && bun typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/flynncode/src/server/server.ts packages/desktop/src/main/sidecar-maintenance.ts packages/desktop/src/main/sidecar-maintenance.test.ts packages/desktop/src/main/sidecar.ts packages/desktop/src/main/server.ts
git commit -m "feat(desktop): keep the sidecar alive through the one-time database compaction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Spec sync and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-25-history-db-retention-design.md`

- [ ] **Step 1: Update the spec's "One-time switch" section** to match what was built:
  - Progress is `started`/`finished` messages, not periodic heartbeats: both SQLite drivers run `VACUUM` synchronously, so nothing can be posted during it. The desktop app switches its stall timeout to 30 minutes on `started` and back to 60 seconds on `finished`.
  - The loading screen has no status-text channel, so it shows the normal loading state; the reason is logged in the desktop `main.log` and the server log.
  - New databases are created in incremental mode directly (`PRAGMA auto_vacuum = INCREMENTAL` before migrations), so they never need the conversion.

- [ ] **Step 2: Full verification**

```bash
cd packages/core && bun test test/database-maintenance.test.ts test/database-migration.test.ts test/database-permissions.test.ts test/session-create.test.ts && bun typecheck
cd ../flynncode && bun test test/storage test/auth test/snapshot && bun typecheck
cd ../server && bun typecheck
cd ../desktop && bun test src/main && bun typecheck
```
Expected: all pass. Report any pre-existing failures separately with their output.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-25-history-db-retention-design.md
git commit -m "docs: sync history DB retention spec with the implementation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
