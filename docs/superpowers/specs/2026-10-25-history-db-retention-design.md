# History DB Retention Design

Date: 2026-10-25
Status: approved design, pending implementation plan

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
  - it has no `session_message` rows and no `session.next.*` events (not v2);
  - it has no pending `session_input` rows;
  - its `event_sequence.owner_id` is null (no process is driving it);
  - it still has prunable events.
- Prunable event types are those whose type starts with `message.` (which
  includes `message.part.*`). `session.*` events are kept.
- Deletes use the existing `event_aggregate_type_seq_idx` index, in chunks of
  about 2,000 rows (`DELETE ... WHERE rowid IN (SELECT rowid ... LIMIT 2000)`).
  Each chunk is its own short transaction, with a yield between chunks, so the
  write lock is never held for long. The logs already show
  `database is locked` errors, so this matters.
- `event_sequence` rows are never touched, so a pruned session that resumes
  appends at `seq + 1` as normal.

**2. Sweep orphans.**
- Delete `event_sequence` rows whose `aggregate_id` starts with `ses_` and has
  no matching `session` row. Events cascade from `event_sequence`. Session
  creation commits the event and the session row in one transaction, so this
  cannot race a new session.
- Delete `Global.Path.data/storage/session_diff/<sessionID>.json` files whose
  session no longer exists. `session_diff` is written by
  `packages/flynncode/src/session/revert.ts`, and core must not depend on the
  server package, so this is a separate hourly sweep in
  `packages/flynncode/src/storage/`, not part of `DatabaseMaintenance`.

**3. Reclaim space.**
- Only once `auto_vacuum = INCREMENTAL` is active.
- Run `PRAGMA incremental_vacuum(10000)` (10,000 pages ≈ 40 MB at the 4 KB
  page size) repeatedly, yielding between steps, until `freelist_count` is 0.

**Logging.** One INFO line per pass: candidate sessions, sessions pruned, event
rows deleted, orphan aggregates removed, diff files removed, MB reclaimed,
duration.

### One-time switch to incremental mode

- **When:** during server startup, after `DatabaseMigration.apply` and before
  the server reports ready, if `PRAGMA auto_vacuum` is not `2` (INCREMENTAL).
  This happens once per database file.
- **Order:** run step 1 (prune) and step 2 (orphan sweep) first, so the
  rewrite copies only kept data. Then `PRAGMA auto_vacuum = INCREMENTAL;
  VACUUM;`.
- **Temp location:** `VACUUM` writes a temporary copy about the size of the
  database. It must go on the data directory's disk, never `/tmp` (the owner's
  `/tmp` is a quota-limited tmpfs). Set `PRAGMA temp_store_directory` to a
  directory under `Global.Path.data`; if the driver rejects the pragma, set
  `SQLITE_TMPDIR` before the database is opened.
- **Skip conditions:** free space on the data directory's filesystem is less
  than the database size plus 1 GB, or the `VACUUM` reports `SQLITE_BUSY`
  (another process, such as a CLI or TUI instance, has the database open). In
  both cases log the reason, leave the database unchanged, and retry on the
  next launch. `VACUUM` is atomic, so a crash or kill midway leaves the old
  database intact.
- **Progress reporting:** core does not know about the desktop sidecar. The
  compaction reports `{ phase, progress }` through an optional callback that
  the process entry point supplies; the sidecar entry forwards it to the
  desktop main process, and the CLI entry prints it.
- **Desktop app:**
  - While compaction runs, the sidecar posts
    `{ type: "maintenance", phase, progress }` every few seconds.
  - Each message resets `SIDECAR_START_STALL_TIMEOUT` (60s) in
    `packages/desktop/src/main/server.ts`, so the sidecar is not killed.
  - The loading screen shows "Optimizing history database (one-time)…".
- **CLI/TUI:** print the same line once; startup is slower that one time only.

### Opt-out

`OPENCODE_DISABLE_DB_MAINTENANCE=1` (added to `packages/core/src/flag/flag.ts`,
following the existing `OPENCODE_DISABLE_*` flags) disables both the hourly
pass and the one-time compaction.

## Error handling

- A failing step never takes down the server. Each step logs its error with
  the step name and the next hourly pass retries; every step is safe to repeat.
- If a delete chunk hits `SQLITE_BUSY` after the normal 5s `busy_timeout`, the
  pass stops and resumes next hour instead of retrying in a tight loop.
- The candidate rules exclude live work: recent activity, pending input, an
  owner claim, or any v2 data.

## Testing

All in `packages/core` against real temporary SQLite databases, no mocks.

1. Pruning a classic session idle for 7 days removes its `message.*` events
   and keeps `session.created`, `event_sequence.seq`, messages and parts; a
   new append still gets `seq + 1`.
2. Recent sessions, v2 sessions, sessions with pending input, and owned
   sessions are untouched.
3. The orphan sweep removes events for a deleted session and keeps every live
   session's events.
4. First-run compaction switches `auto_vacuum` to incremental and the file
   shrinks after pruning; a second startup is a no-op.
5. Insufficient free disk or a busy database makes compaction skip cleanly and
   leaves the database unchanged.
6. Incremental reclaim lowers `freelist_count` after a prune.
7. The desktop startup stall timer resets on `maintenance` messages
   (`packages/desktop`).
8. The `session_diff` sweep removes files for deleted sessions only
   (`packages/flynncode`).

## Out of scope

- Worktree cleanup (own spec).
- Session retention: auto-archive or delete of old sessions (own spec).
- UI responsiveness (own spec).
- Changing which events are written. Classic sessions keep writing update
  events; they are pruned later.
