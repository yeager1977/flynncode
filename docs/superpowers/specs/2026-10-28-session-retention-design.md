# Session Retention Design

Date: 2026-10-28
Status: implemented (7c86fdf727, 859d9ef1e6), with the final-review fixes for running across machines

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
  - A retention tombstone never outranks activity the deleting machine did not see (see [Sync](#sync)).

## Design

### Rule

- **Setting:** `cleanupPeriodDays`, a top-level key in the Flynncode config (`~/.config/flynncode/opencode.jsonc`).
  - It is an integer; the default is 30 and the minimum is 1. A value of 0 or below is rejected, as in Claude Code.
- **Unit of deletion:** a whole session tree, the root plus every descendant sub-agent session. A sub-agent session is never deleted on its own.
- **Inactive:** the latest activity anywhere in the tree is older than `cleanupPeriodDays`. Activity is the newest of these, for the root and every descendant:
  - session, message, part, todo, session-folder and V2 message update times;
  - the latest V2 input's creation time.
  - These are the rows machine sync dates a chat by, so a tree's activity matches its sync version.
  - Archived and unarchived sessions are treated the same.
  - A future timestamp (clock skew) counts as active.
- **Exempt trees** are never deleted:
  - **Keep:** `keep: true` in the root session's metadata.
  - **Hold:** `retentionHold: true` in the root session's metadata (see [Schedules](#schedules)), treated like Keep.
  - **Scheduled:** a session of the tree has an unexpired job in this database's `session_schedule`.
  - **Busy:** a session of the tree
    - has a non-idle run state in this process,
    - has a pending permission or question in this process,
    - has a running background shell in this process, or
    - has a latest assistant message without a completion time in the database.
  - The process-local signals are tracked from the process-wide GlobalBus (`session.status`, `session.idle`, `permission.asked`/`replied`, `question.asked`/`replied`/`rejected` and their V2 forms), so no instance is loaded to read them.
  - The database rule covers turns another process drives, including one waiting on the user, which writes nothing while it waits. Only the latest assistant message counts, so a newer one ends an older unfinished one. The scheduler bounds its version of this rule by recent writes; retention cannot, because it only looks at trees idle for days. A turn a crash left unfinished keeps its tree until the session runs again.
- **Keep** is written merge-safely and syncs with the session.

### Where it runs

- **Service:** `SessionRetention` in `packages/flynncode/src/session/retention`. It runs hourly, starting 5 minutes after launch.
- **Opt-in entry points:** a process polls only after `SessionRetention.enable()`.
  - Only the desktop sidecar and the TUI worker call it.
  - `serve`, `web`, `acp`, `flynncode run`, plugin clients and tests never delete sessions on their own. Retention does not follow scheduler leadership.
  - It never runs while `SYNC_HUB_MODE` is set, even when enabled. The hub holds every machine's chats under its own defaults, and its deletions would reach every machine.
- **Leader:** among the enabled processes on one database, only the leader runs passes. It holds a cross-process lock (`Flock`, key `session-retention:<database path>`) like the scheduler's, with its own key.
  - Before each deletion the leader checks that the lock is still its own (`Flock.Lease.held()`). After a suspend or stall past the 60-second stale time, another process may have broken the lock. The old leader then drops its lease and stops deleting.
- **Pass:**
  1. Reconcile schedule holds (see [Schedules](#schedules)).
  2. Read the period. An invalid config dies here, and nothing is deleted.
  3. List the due, non-exempt trees, oldest first.
  4. Skip the deletions when hub sync is stale (see [Sync](#sync)).
  5. Apply the surge delay (see [What the user sees](#what-the-user-sees)).
  6. Delete at most 50 trees, so a big first sweep never stalls the server.
- **Deletion path:** the manual delete, without loading the project (`SessionRemoval.removeDetached`).
  - **Re-check:** right before each tree is deleted, the tree is re-read and its activity and exempt state, busy included, checked again. Nothing awaits between that check and the delete.
  - `Session.remove` recurses through the children, removes events, scheduled jobs and transcripts, and writes the tombstones. Without an instance, the deleted events are still routed to the session's folder, so its clients drop it.
  - The root's disposable task worktree is disposed only when nothing would be lost, through the worktree service directly. The project's main checkout stands in for the calling instance, and nothing is loaded.
  - **Skipped without an instance:**
    - SessionEnd hooks and background-job cancellation. A busy tree is never deleted.
    - Disposal of a worktree whose own instance is loaded. The worktree service refuses it.
    - Keep-N worktree retention. It reads the project config.
    - A worktree left behind stays on the Cleanup page, and keep-N retention removes it when the project next creates a worktree.
    - Sub-agent worktree bindings are not disposed, as with a manual delete.
  - The existing hourly sweeps clean up session diffs and orphaned events.
- **No instance boot:** a pass never loads a project instance. It does not run plugins, start snapshot loops or watch files for old projects.
- **Logging:** one line per pass, giving sessions and trees considered, eligible and deleted trees, removed sessions, failures, and a delay or skip.

### What the user sees

- **Session menu:** root sessions get **"Keep forever"** and **"Stop keeping"** in the session context menu. Sub-agents follow their parent.
  - The toggle calls `PATCH /session/{id}/keep` (SDK `client.session.keep`).
  - A kept session shows a small pin icon next to its title in the sidebar.
  - Toggling Keep counts as activity, so "Stop keeping" grants a fresh period.
  - Only the new-layout sidebar has the menu item, pin, hint and notice.
- **Settings:** General settings gets a "Session history" row: "Delete sessions inactive for more than [30] days". The number field has a minimum of 1 and writes `cleanupPeriodDays` to the global Flynncode config. The next pass uses the new value.
- **Heads-up:** for a session tree within 3 days of deletion, the menu shows a faint "deletes in N days" hint next to "Keep forever".
- **Surge protection:** a pass waits 24 hours when it would delete a surge:
  - the first pass that finds anything to delete, when it finds more than 20 trees;
  - a pass after `cleanupPeriodDays` was lowered, when more than 20 trees are newly eligible (due under the new period, not under the period the last pass used).
  - A pass with nothing to delete spends neither. It also drops a pending delay that no longer applies, for example after the period was raised again.
  - **Notice:** the app shows a notice for each delay, saying how many top-level sessions the cleanup removes and when, with a link to the setting. It remembers the delay it announced (`firstRunAt`) per app profile, so a later delay shows again.
  - **State:** `Global.Path.state/session-retention-<database name>.json`, one per channel database, stores:
    - `firstRunAt` and `pendingFirstRunCount` while a delay is pending;
    - `completedAt` and `periodDays` of the last pass that ran;
    - `holds`.
  - The delay survives restarts. A state file without `periodDays` (written before this rule) gets a first-run check again.
- **Unchanged:** archive and the Cleanup page.

### API

- **Hint data:** `GET /session/retention` (SDK `client.session.retention.get`) returns `{ cleanupPeriodDays, firstRunAt?, pendingFirstRunCount?, expiring: Array<{ sessionID, deletesAt }>, kept: string[] }`.
  - `expiring` lists non-exempt root sessions due within 3 days. While a delay is pending, `deletesAt` is at least `firstRunAt`.
  - `kept` lists the root sessions with `keep: true`. The app's session list carries no metadata, so the sidebar reads Keep from here. A Keep set on another machine shows after the next retention event.
  - The app uses it for the hints, the pins and the notice.
  - It is served locally and never proxied to a workspace.
- **Keep toggle:** `PATCH /session/{id}/keep { keep: boolean }` (SDK `client.session.keep`).
  - It returns the updated session, 400 for a sub-agent session and 404 for a missing one.
  - A new route was needed because `PATCH /session/{id}` replaces `metadata` wholesale.
  - The write goes through `Session.updateMetadata`, under the session's write lock (see [Sync](#sync)).
- **Event:** `session.retention.updated`, with empty properties, is published on the global bus after every pass, a Keep toggle or a change to `cleanupPeriodDays`. The app refetches when it arrives.

### Schedules

- **Problem:** scheduled jobs (`session_schedule`) are local to one database and never sync.
- **Hold:** while a tree has an unexpired job in this database, the leader sets `retentionHold: true` in the root's metadata. The flag syncs with the session, and every machine treats it like Keep.
- **Clearing:** the leader clears the flag once the tree's last job here is gone or expired.
  - It clears only holds it set. The roots it holds are recorded in the state file's `holds`.
  - A hold synced from a machine whose job still runs is never cleared elsewhere.
  - When jobs on two machines hold one tree and one ends, the other machine sets the hold again on its next pass.
- **Timing:** the leader reconciles holds at the start of every pass, so a hold appears or clears within an hour.
  - Writing the flag counts as activity, which also carries it to the other machines.
  - A tree is new or active when its job is created, so the hour's lag does not expose it.
- **Writes:** holds are written through `Session.updateMetadata`, like Keep.
- **Gap:** a machine that only runs `serve` has no retention leader, so its jobs set no hold.

### Sync

- **Tombstone basis:** a retention deletion records its basis, the tree's latest activity.
  - Sync compares a peer's `timeUpdated` against `time_deleted`. A retention tombstone stamps `time_deleted = basis + 1 ms` instead of the wall-clock deletion time.
  - Mechanism: `SessionProjector.TombstoneBasis` is provided around the delete. Projectors run inside the publishing fiber, so every member's tombstone carries the basis.
  - A peer copy with activity after the basis therefore outranks the tombstone:
    - `decidePush` does not push the delete;
    - `decide` on the peer keeps its copy;
    - the deleting machine pulls the chat back.
  - A copy nobody touched since is still deleted everywhere.
  - Manual deletes keep the wall-clock time.
- **Tombstone expiry:** `session_tombstone.time_recorded` (migration `20261028152423_session_tombstone_recorded`) records when the row was written.
  - Tombstones are pruned 30 days after `time_recorded`, or after `time_deleted` for rows from before the column existed.
  - Without it, a retention tombstone, whose basis is already older than the period, would be pruned at once.
  - A tombstone a peer's delete writes records its arrival time.
- **Stale sync:** passes skip their deletions while hub sync is set up but has not completed a cycle in the last 24 hours.
  - The sync worker runs in the desktop sidecar and keeps its last success only in memory (`SyncStatus.lastSuccess`). After every cycle the sidecar calls `SessionRetention.recordSync({ paired, lastPull })`.
  - That writes `Global.Path.state/session-retention-sync-<database name>.json` when the value changes. Every process that leads retention on that database, the TUI included, reads it.
  - An unreadable record counts as stale.
- **Whole-chat conflicts:**
  - Sync replaces a whole chat with the newer copy. A Keep or hold set on machine A is lost if machine B writes the same session again before the next cycle: B's newer copy, without the flag, wins on A.
  - The pin then disappears, and the tree can later be deleted. This is not fixed. The user docs tell the owner to check the pin after the next sync.
- **Write lock:** `Session.updateMetadata` takes a per-session lock that every `Session` write in the process shares, so a Keep or hold never drops another key this process writes concurrently. Writers in other processes on the same database are not covered.
- **Orphans:** a peer that keeps a newer sub-agent copy while deleting its root leaves an orphan sub-tree. Orphan sub-trees are never deleted, which is the safe direction.

## Error handling

- **Isolation:** a failing pass is logged and retried on the next hour. A failure deleting one tree is logged, and the pass continues with the others. A failure writing a hold is logged and retried on the next pass.
- **Bad config:** an invalid `cleanupPeriodDays` (non-integer or below 1) fails config validation with a clear message, and retention does not run until it is fixed. It never falls back to deleting with a guessed value.
- **Clock skew:** a tree whose latest activity is in the future is treated as active.
- **Sync (accepted risks):**
  - **Unsynced Keep:** a Keep that has not synced yet does not stop a machine with an older copy from deleting the tree. That machine's tombstone is stamped with its older basis, while the Keep counts as activity on the machine that set it.
    - So the kept copy survives there and syncs back to the others.
    - Machines that had not seen the Keep either delete their copies meanwhile. The session is missing there until the kept copy returns.
    - An archived kept session is not pushed back (archived chats stay local), so only the machine that kept it still has it.
  - **Lost Keep:** a Keep can be lost to a whole-chat conflict (see [Sync](#sync)). The tree is then deleted like any other.
  - **Activity not seen:** activity the deleting machine did not see is no longer a risk. The tombstone basis keeps newer copies, and a stale sync skips passes.
  - Both remaining risks are documented as "Keep a session before its last day".

## Testing

All tests use the real database and an injectable clock, with no mocks.

1. **Inactivity:** a tree older than N days is deleted, children included. A tree with any recent descendant activity is kept.
2. **Exemptions:** `keep: true` or `retentionHold: true` on the root exempts the tree. So do an active schedule and a running background shell.
   - **Busy:** a running turn, a pending permission or question, or an unfinished latest assistant message in the database. A newer assistant message ends an older unfinished one.
3. **Pass cap:** at most 50 trees are deleted per pass.
4. **Surges:**
   - More than 20 eligible trees delays the first pass by 24 hours, and the delay survives a restart. 20 or fewer runs immediately.
   - A first pass with nothing to delete does not spend the delay.
   - Lowering the period so that more than 20 trees become newly eligible delays the pass and announces it. 20 or fewer runs immediately. Raising the period again drops the delay.
5. **Config:** `cleanupPeriodDays` validation (0 is rejected) and changing the value. An invalid value in a real global config file, read by the real loader, makes the pass fail without deleting.
6. **Deletion path:**
   - Deletion writes tombstones stamped with the tree's activity plus 1 ms and recorded now.
   - It disposes a disposable task worktree.
   - It deletes a tree whose folder is gone.
   - It never loads an instance for the tree's folder.
7. **Single runner:**
   - Only the leader process runs passes.
   - A leader whose lock another process broke stops deleting.
   - Only an enabled, non-hub process polls. The sidecar and the TUI worker enable retention; `serve`, `web` and `acp` do not.
   - Under a test clock, the real timer polls after the first-pass delay only when enabled and not in hub mode.
8. **Route:** `GET /session/retention` returns the expiring list and the first-run info.
9. **App:** menu Keep toggle helper, pin icon, "deletes in N days" hint, settings row and the delay notice (browser suite). A later delay shows the notice again.
10. **Across machines:**
    - The review's laptop/desktop scenario runs against the real `decide`/`decidePush` with a manifest read from a database retention deleted from. The newer copy is kept and pulled back. A copy nobody touched is still deleted.
    - A stale sync skips the pass, and an unpaired machine runs.
    - A schedule sets a hold, which protects the tree like Keep, and only the machine that set it clears it.
    - Expired tombstones are pruned by recorded time.

## Out of scope

- Per-project retention periods.
- A "local only" retention mode that does not propagate.
- Bulk "delete archived" actions.
