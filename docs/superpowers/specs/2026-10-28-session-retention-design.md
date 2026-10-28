# Session Retention Design

Date: 2026-10-28
Status: approved design, pending implementation plan

## Problem

Flynncode never deletes old sessions. History grows without bound: the database, its events, session diffs, task worktrees and Claude transcripts.

The 2026-10-25 work made the history database prune its own redundant rows (`2026-10-25-history-db-retention-design.md`) and cleaned up worktrees (`2026-10-25-worktree-cleanup-design.md`). This spec covers the third piece, retention for sessions themselves.

## Decisions

- **Claude-aligned.**
  - A session tree that has been inactive for `cleanupPeriodDays` (default 30) is deleted automatically. A tree is a root session plus all of its sub-agent sessions.
  - Sub-agent sessions are only ever deleted with their parent.
  - Archive stays hide-only.
- **A Keep toggle.** Marking a session "Keep forever" exempts its whole tree.
- **Deletions propagate like a manual delete.** An automatically deleted session is deleted on every synced machine, through the same tombstone path. Keep travels with the session, so a kept session is safe everywhere. The machine with the shortest period effectively sets the limit.

## Design

### Rule

- **Setting:** `cleanupPeriodDays`, a top-level key in the Flynncode config (`~/.config/flynncode/opencode.jsonc`).
  - It is an integer; the default is 30 and the minimum is 1. A value of 0 or below is rejected, as in Claude Code.
- **Unit of deletion:** a whole session tree, the root plus every descendant sub-agent session. A sub-agent session is never deleted on its own.
- **Inactive:** the latest activity anywhere in the tree is older than `cleanupPeriodDays`. Activity means session, message and part update times for the root and every descendant.
  - A running session updates constantly, so it never qualifies.
  - Archived and unarchived sessions are treated the same.
  - A tree with an active scheduled job, pending wakeup or running background shell is skipped.
- **Keep:** `keep: true` in the root session's metadata exempts the tree. It is written merge-safely and syncs with the session.

### Where it runs

- **Service:** `SessionRetention` in `packages/flynncode`. It runs hourly, starting 5 minutes after launch.
  - It runs only in the long-lived server process that leads (the same per-machine lock pattern as the scheduler, with its own lock). Several processes on one database therefore don't run passes at once.
  - Each pass deletes at most 50 trees, so a big first sweep never stalls the server.
- **Deletion path:** exactly the manual-delete path.
  - `Session.remove` recurses through the children and removes events. The projector writes the tombstone that hub sync propagates.
  - Disposable task worktrees and entered worktrees are disposed only when nothing would be lost.
  - Scheduled jobs and transcripts are removed by their existing session-removal hooks.
  - The existing hourly sweeps clean up session diffs and orphaned events.
- **Logging:** one line per pass, giving sessions considered, trees deleted and sessions removed.

### What the user sees

- **Session menu:** root sessions get **"Keep forever"** and **"Stop keeping"** in the session context menu. Sub-agents follow their parent.
  - The toggle writes `metadata.keep` through the existing session update API.
  - A kept session shows a small pin icon next to its title in the sidebar.
- **Settings:** General settings gets a "Session history" row: "Delete sessions inactive for more than [30] days". The number field has a minimum of 1 and writes `cleanupPeriodDays` to the global Flynncode config. The next pass uses the new value.
- **Heads-up:** for a session tree within 3 days of deletion, the menu shows a faint "deletes in N days" hint next to "Keep forever".
- **First-run protection:**
  - If more than 20 trees would be deleted on the first pass after retention ships, that pass waits 24 hours.
  - A one-time notice says how many sessions will be removed and when, with a link to the setting.
  - The time of the first eligible pass is stored in Flynncode's state directory, so the delay survives restarts.
- **Unchanged:** archive and the Cleanup page.

### API

- **Hint data:** `GET /session/retention` returns `{ cleanupPeriodDays, firstRunAt?, pendingFirstRunCount?, expiring: Array<{ sessionID, deletesAt }> }`. `expiring` lists root sessions due within 3 days. The app uses it for the hints and the notice.
- **Keep toggle:** uses the existing session metadata update route. No new route is needed if that route can set `metadata.keep` merge-safely. Otherwise add `PATCH /session/{id}/keep { keep: boolean }`.
- **Event:** `session.retention.updated` is published after a pass or a setting change. The app refetches when it arrives.

## Error handling

- **Isolation:** a failing pass is logged and retried on the next hour. A failure deleting one tree is logged, and the pass continues with the others.
- **Bad config:** an invalid `cleanupPeriodDays` (non-integer or below 1) fails config validation with a clear message, and retention does not run until it is fixed. It never falls back to deleting with a guessed value.
- **Clock skew:** a tree whose latest activity is in the future is treated as active.
- **Sync:** a tree that is kept on another machine but not yet synced here can be deleted here first. This is accepted, and documented as "Keep a session before its last day".

## Testing

All tests use the real database and an injectable clock, with no mocks.

1. **Inactivity:** a tree older than N days is deleted, children included. A tree with any recent descendant activity is kept.
2. **Exemptions:** `keep: true` on the root exempts the tree. A tree with an active schedule or a running background shell is skipped.
3. **Pass cap:** at most 50 trees are deleted per pass.
4. **First run:** more than 20 eligible trees delays the pass by 24 hours, and the delay survives a restart. 20 or fewer runs immediately.
5. **Config:** `cleanupPeriodDays` validation (0 is rejected) and changing the value.
6. **Deletion path:** deletion writes tombstones through the manual-delete path.
7. **Single runner:** only the leader process runs passes.
8. **Route:** `GET /session/retention` returns the expiring list and the first-run info.
9. **App:** menu Keep toggle helper, pin icon, "deletes in N days" hint, settings row and first-run notice (browser suite).

## Out of scope

- Per-project retention periods.
- A "local only" retention mode that does not propagate.
- Bulk "delete archived" actions.
