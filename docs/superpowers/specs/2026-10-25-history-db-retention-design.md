# History DB Retention Design

Date: 2026-10-25
Status: implemented

## Problem

Flynncode never shrinks its history database. The owner's `opencode-dev.db`
reached 38.8 GB on 2026-10-19 and had to be repaired and compacted by hand; six
days later it is 13.4 GB again and growing by roughly 70K event rows per day.

- There is no row pruning, no orphan sweep, and no `VACUUM` anywhere in the code.
- `PRAGMA auto_vacuum` is `NONE`, so freed pages never return to the filesystem.
- Most of the file is the `event` table: 1.47M rows, of which 1.13M are
  `message.part.updated.1` and 280K are `message.updated.1`. For classic (v1)
  sessions these duplicate the authoritative `message` and `part` tables.
- Events are removed only by `Session.remove` → `EventV2.remove`. Archived and
  idle sessions keep every event forever, and a delete that fails partway
  leaves orphaned events behind.

This spec covers the history database only. Worktree cleanup, session
retention (auto-archive/delete of old sub-agent sessions), and UI
responsiveness are separate follow-up specs.

## What depends on event rows

| Consumer | Needs old event rows? |
|---|---|
| New appends (`commitDurableEvent`) | No. Uses `event_sequence.seq`, not prior rows. |
| Machine sync bundles (`machine-sync/store.ts`) | No. Applies message/part rows directly; events are copied verbatim without checks. |
| v2 session history (`V2Session.history` → `EventV2.readAggregate`) | **Yes.** v2 sessions must never be pruned. |
| Workspace replay (control-plane) | Re-applying an already-applied event whose row is gone dies with "Replay diverged". Only idle sessions are pruned, so live workspace replay is unaffected; the owner does not use workspaces. |
| Durable event streams (`events.durable({ after })`) | Returns rows after `after` that still exist; idle sessions have no live subscribers. |

Experimental workspace warp/sync of a pruned classic session only carries its
remaining `session.*` events; its messages and parts are not replayed from
events.

## Decisions

1. **Prune when idle 7 days.** Once a classic session has been idle for 7 days,
   delete its `message.*` and `message.part.*` update events. Messages, parts,
   `session.*` events and `event_sequence` are kept.
2. **One-time compaction, then automatic reclaim.** On first launch of the new
   build, switch the database to `auto_vacuum = INCREMENTAL` with a single
   `VACUUM`. After that, every maintenance pass reclaims freed pages with
   `PRAGMA incremental_vacuum`.
3. **Architecture.** A periodic `DatabaseMaintenance` service in
   `packages/core/src/database/`, registered the same way as the existing
   ToolOutputStore cleanup loop.

## Design

### Hourly maintenance pass

`DatabaseMaintenance` starts 1 minute after server launch and repeats every
hour. Each pass runs three steps in order.

**1. Prune idle classic sessions.**
- A session is a candidate only when all of these hold:
  - `session.time_updated` is older than 7 days;
  - no `message` or `part` row of the session has `time_updated` at or after
    the cutoff (message and part writes do not bump `session.time_updated`;
    both tables are indexed on `session_id, time_updated`);
  - it has no `session_message` rows and no `session.next.*` events (not v2);
  - it has no pending `session_input` rows;
  - its `event_sequence.owner_id` is null (no process is driving it);
  - it still has prunable events.
- Prunable event types are those whose type starts with `message.` (which
  includes `message.part.*`). `session.*` events are kept.
- Deletes use the existing `event_aggregate_type_seq_idx` index, in chunks of
  about 2,000 rows (`DELETE ... WHERE rowid IN (SELECT rowid ... LIMIT 2000)`).
  Each chunk is its own short transaction, with a yield between chunks, so the
  write lock is never held for long. Eligibility (idle, unowned, no pending
  input, no recent message or part) is re-checked inside every chunk, because
  the pass runs beside a live server and a session can resume between
  selection and deletion. The logs already show
  `database is locked` errors, so this matters.
- `event_sequence` rows are never touched, so a pruned session that resumes
  appends at `seq + 1` as normal.

**2. Sweep orphans.**
- Delete `event_sequence` rows whose `aggregate_id` starts with `ses_` and has
  no matching `session` row. Events cascade from `event_sequence`. Session
  creation commits the event and the session row in one transaction, so this
  cannot race a new session. A session can still be re-created with the same
  id (sync, import) while the sweep runs, so every event chunk and the final
  `event_sequence` delete re-check that the session row is still absent.
- Delete `Global.Path.data/storage/session_diff/<sessionID>.json` files of
  deleted sessions. `session_diff` is written by
  `packages/flynncode/src/session/revert.ts`, and core must not depend on the
  server package, so this is a separate hourly sweep in
  `packages/flynncode/src/storage/session-diff-sweep.ts`, not part of
  `DatabaseMaintenance`. `storage/` is shared by every channel's database, so
  "no session row" does not mean deleted (it may be another channel's live
  session). A file is removed only when this database has a `session_tombstone`
  for the session and no live `session` row. The sweep logs its own removal
  count.

**3. Reclaim space.**
- Only once `auto_vacuum = INCREMENTAL` is active.
- Run `PRAGMA incremental_vacuum(10000)` (10,000 pages ≈ 40 MB at the 4 KB
  page size) repeatedly, yielding between steps, until `freelist_count` is 0.
- When pages were freed, run `PRAGMA wal_checkpoint(TRUNCATE)` so the WAL does
  not stay at its high-water mark. Failure or `SQLITE_BUSY` is ignored.

Each step is isolated: a failing step logs its name and falls back to an empty
result, and the others still run.

**Logging.** One INFO line per pass: candidate sessions, sessions pruned, event
rows deleted, orphan aggregates and events removed, MB reclaimed, duration.
The diff sweep logs its own removal count.

### One-time switch to incremental mode

- **New databases:** `PRAGMA auto_vacuum = INCREMENTAL` is the first pragma,
  and the driver's own WAL switch is deferred (`disableWAL`) so it cannot write
  the first page first. A new database is therefore born incremental and never
  needs the conversion. A busy result on that pragma is ignored.
- **Existing databases:** `compactOnce` runs inside the database layer, after
  `DatabaseMigration.apply` and before the server is ready, if `PRAGMA
  auto_vacuum` is not `2` (INCREMENTAL). This happens once per database file.
- **Once per process:** the database layer is built more than once per process
  (desktop builds it again lazily in `stop()`, where main kills the sidecar
  after 6s). Only the first `compactOnce` call in a process may attempt the
  conversion; later calls return `"attempted"` without pruning or `VACUUM`.
- **Attempt marker and backoff:** before the prune + `VACUUM` attempt,
  `<db>.compact-attempt` (beside the database) is written with the number of
  unfinished attempts, including this one. A clean outcome (`compacted`,
  `low-disk`, or `skipped` for a handled step failure) removes it. A launch
  that was killed or crashed mid-attempt leaves it, and so does a `VACUUM`
  failure that is not `SQLITE_BUSY`/locked (corruption, a full disk), which
  returns `"failed"`. A busy database (another process holds it) restores the
  previous count, so it never counts. When the marker already holds 3,
  compaction returns `"backoff"` without pruning or `VACUUM` and logs a warning
  to set `OPENCODE_DISABLE_DB_MAINTENANCE=1` or report it (deleting the marker
  retries). Marker read/write failures are logged and never fatal.
- **Order:** `started` is reported, then step 1 (prune) and step 2 (orphan
  sweep) run first, so the rewrite copies only kept data. Then `PRAGMA
  auto_vacuum = INCREMENTAL; VACUUM;`. After the attempt (success or not) the
  WAL is truncated with `wal_checkpoint(TRUNCATE)` so the rewritten database
  does not linger in the WAL at full size, and `finished` is reported.
- **Temp location:** `VACUUM` writes a temporary copy about the size of the
  database. It must go on the data directory's disk, never `/tmp` (the owner's
  `/tmp` is a quota-limited tmpfs). `PRAGMA temp_store_directory` points at a
  `.vacuum-tmp` directory beside the database file, removed afterwards. No
  `SQLITE_TMPDIR`.
- **Never fails:** `compactOnce` cannot take down the server. Any failing or
  dying step logs its name and returns `"skipped"`; the next launch retries
  (subject to the attempt-marker backoff). If `VACUUM` fails, `auto_vacuum` is
  set back to `NONE`; `VACUUM` is atomic, so a crash or kill midway leaves the
  old database intact.
- **Skip conditions:** free space on the data directory's filesystem is less
  than `2 * kept + 1 GiB`, where `kept` is the database size excluding free
  pages, measured after the prune (in WAL mode the rewrite also passes through
  the WAL, hence the factor of two). Or `VACUUM` fails, for instance with
  `SQLITE_BUSY` because another process (a CLI or TUI instance) has the
  database open. The reason is logged, the database is left unchanged, and the
  next launch retries.
- **Progress reporting:** core does not know about the desktop sidecar.
  `compactOnce` reports `{ phase: "compact", state: "started" | "finished" }`
  through an optional listener (`DatabaseMaintenance.onProgress`) that the
  process entry point supplies. `started` fires before the prune phase and
  `finished` on every exit after it. There are no periodic heartbeats: both
  SQLite drivers run `VACUUM` synchronously, so nothing can be posted during
  it. Without a listener (CLI/TUI) one line, `Optimizing history database…`, is
  printed to stderr on `started`.
- **Desktop app:**
  - The sidecar forwards each message to the main process as
    `{ type: "maintenance", phase, state }`.
  - On `started`, `packages/desktop/src/main/server.ts` switches the startup
    stall timeout from `SIDECAR_START_STALL_TIMEOUT` (60s) to
    `SIDECAR_MAINTENANCE_TIMEOUT` (30 minutes), so the sidecar is not killed
    mid-`VACUUM`. On `finished` it goes back to 60s.
  - The loading screen has no status-text channel, so it shows its normal
    loading state. The reason is logged in the desktop `main.log` and the
    server log.
- **CLI/TUI:** print the same line once; startup is slower that one time only.
- **Operational note:** close other Flynncode CLI/TUI instances before the
  first launch of this build. The one-time `VACUUM` blocks other processes'
  writes while it runs (and if another process holds the write lock, the
  conversion is skipped until a later launch).

### Opt-out

`OPENCODE_DISABLE_DB_MAINTENANCE=1` (added to `packages/core/src/flag/flag.ts`,
following the existing `OPENCODE_DISABLE_*` flags) disables the hourly pass,
the one-time compaction, and the hourly `session_diff` sweep.

## Error handling

- A failing step never takes down the server. The hourly pass isolates each
  step (it logs the step name and falls back; the next pass retries, and every
  step is safe to repeat). `compactOnce` never fails: any step failure logs and
  returns `"skipped"`.
- If a delete chunk hits `SQLITE_BUSY` after the normal 5s `busy_timeout`, that
  step fails, is logged, and resumes next hour instead of retrying in a tight
  loop.
- The candidate rules exclude live work: recent activity, pending input, an
  owner claim, or any v2 data, and are re-checked inside every delete chunk.

## Testing

Items 1-8 are in `packages/core` against real temporary SQLite databases, no
mocks.

1. Pruning a classic session idle for 7 days removes its `message.*` events
   and keeps `session.created`, `event_sequence.seq`, messages and parts; a
   new append still gets `seq + 1`.
2. Recent sessions, v2 sessions, sessions with pending input, and owned
   sessions are untouched.
3. The orphan sweep removes events for a deleted session and keeps every live
   session's events.
4. First-run compaction switches `auto_vacuum` to incremental and the file
   shrinks after pruning; a second startup is a no-op. New databases are
   created incremental.
5. Insufficient free disk, a failing step, or a failing `VACUUM` makes
   compaction skip cleanly (never fail) and leaves the database unchanged.
6. Incremental reclaim lowers `freelist_count` after a prune, and the hourly
   pass truncates the WAL afterwards.
7. A failing step in the hourly pass is isolated; the others still run.
8. The orphan sweep keeps a session re-created mid-sweep; a session with a
   recent message or part is not pruned; compaction runs once per process,
   backs off at 3 unfinished attempts, and does not count a busy database.
9. The desktop stall timeout switches to 30 minutes on `started` and back to
   60s on `finished` (`packages/desktop`).
10. The `session_diff` sweep removes files only for sessions this database has
    a tombstone for and no live row, and is not scheduled when maintenance is
    disabled (`packages/flynncode`).

## Out of scope

- Worktree cleanup (own spec).
- Session retention: auto-archive or delete of old sessions (own spec).
- UI responsiveness (own spec).
- Changing which events are written. Classic sessions keep writing update
  events; they are pruned later.
