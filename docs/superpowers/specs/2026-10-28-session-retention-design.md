# Session Retention Design

Date: 2026-10-28
Status: implemented (7c86fdf727, 859d9ef1e6), with the final-review fixes for running across machines (c18a1df579), the re-review fixes that make sync deletions tree-atomic (ea3fc3689e), and the second re-review fixes that make a surviving tree converge without re-deletes

## Problem

Flynncode never deletes old sessions. History grows without bound: the database, its events, session diffs, task worktrees and Claude transcripts.

The 2026-10-25 work made the history database prune its own redundant rows (`2026-10-25-history-db-retention-design.md`) and cleaned up worktrees (`2026-10-25-worktree-cleanup-design.md`). This spec covers the third piece, retention for sessions themselves.

## Decisions

- **Claude-aligned.**
  - A session tree that has been inactive for `cleanupPeriodDays` (default 30) is deleted automatically. A tree is a root session plus all of its sub-agent sessions.
  - Sub-agent sessions are only ever deleted with their parent, on every machine: sync judges a retention deletion against the whole tree (see [Sync](#sync)).
  - Archive stays hide-only.
- **A Keep toggle.** Marking a session "Keep forever" exempts its whole tree.
- **Deletions propagate like a manual delete.** An automatically deleted session is deleted on every synced machine, through the same tombstone path. Keep travels with the session, so a kept session is safe everywhere. The machine with the shortest period effectively sets the limit.
  - A retention tombstone never outranks activity the deleting machine did not see, anywhere in the tree, and never deletes a tree that is kept, held or scheduled where it lands (see [Sync](#sync)). Once a tree survives a deletion, it survives it for good, on every machine.

## Design

### Rule

- **Setting:** `cleanupPeriodDays`, a top-level key in the Flynncode config (`~/.config/flynncode/opencode.jsonc`).
  - It is an integer; the default is 30 and the minimum is 1. A value of 0 or below is rejected, as in Claude Code.
- **Unit of deletion:** a whole session tree, the root plus every descendant sub-agent session. A sub-agent session is never deleted on its own, here or, through sync, on another machine.
- **Inactive:** the latest activity anywhere in the tree is older than `cleanupPeriodDays`. Activity is the newest of these, for the root and every descendant:
  - session, message, part, todo, session-folder and V2 message update times;
  - the newest V2 input creation time (`max(time_created)`, whatever order the inputs were admitted in).
  - These are the rows machine sync dates a chat by. Both read them through one helper, `SessionActivity.content`, so a tree's activity is exactly the newest sync version of its members.
  - Archived and unarchived sessions are treated the same.
  - A future timestamp (clock skew) counts as active.
- **Exempt trees** are never deleted:
  - **Keep:** `keep: true` in the root session's metadata.
  - **Hold:** `retentionHold: true` in the root session's metadata with a `retentionHoldUntil` still ahead (see [Schedules](#schedules)), treated like Keep. A hold without a numeric expiry, or past it, has lapsed.
  - **Scheduled:** a session of the tree has an unexpired job in this database's `session_schedule`.
  - **Busy:** a session of the tree
    - has a non-idle run state in this process,
    - has a pending permission or question in this process,
    - has a running background shell in this process, or
    - has, in the database, a latest V1 assistant message without a completion time, a latest V2 assistant message (`session_message`) without a completion time, or a V2 input admitted but not yet promoted (`session_input.promoted_seq IS NULL`).
  - The process-local signals are tracked from the process-wide GlobalBus (`session.status`, `session.idle`, `permission.asked`/`replied`, `question.asked`/`replied`/`rejected` and their V2 forms), so no instance is loaded to read them.
  - The database rules cover turns another process drives, in either engine, including one waiting on the user, which writes nothing while it waits: V2 keeps pending permissions and questions in memory only, but the waiting turn's assistant message stays open. Only the latest assistant message counts, so a newer one ends an older unfinished one. The scheduler bounds its version of this rule by recent writes; retention cannot, because it only looks at trees idle for days. A turn or input a crash left unfinished keeps its tree until the session runs again.
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
  - A kept session shows a small pin icon next to its title in the sidebar, with the tooltip "Kept forever".
  - A held session (see [Schedules](#schedules)) shows the same pin with the tooltip "Held by a schedule". Keep wins the tooltip when both apply.
  - Toggling Keep counts as activity, so "Stop keeping" grants a fresh period.
  - Only the new-layout sidebar has the menu item, pin, hint and notice.
- **Settings:** General settings gets a "Session history" row: "Delete sessions inactive for more than [30] days". The number field has a minimum of 1 and writes `cleanupPeriodDays` to the global Flynncode config. The next pass uses the new value.
  - While hub sync is stale (see [Sync](#sync)), the row adds "Automatic cleanup is paused until sync catches up".
- **Heads-up:** for a session tree within 3 days of deletion, the menu shows a faint "deletes in N days" hint next to "Keep forever".
- **Surge protection:** a pass waits 24 hours when it would delete a surge:
  - the first pass that finds anything to delete, when it finds more than 20 trees;
  - a pass after `cleanupPeriodDays` was lowered, when more than 20 trees are newly eligible (due under the new period, not under the period the last pass used);
  - a pass during a pending delay after the period was lowered again, when more than 20 trees are newly eligible compared with the period the delay announced. The delay restarts with a new `firstRunAt`, so the app shows a new notice with the new count. Otherwise a pass during a delay only recounts `pendingFirstRunCount`.
  - A pass with nothing to delete spends neither. It also drops a pending delay that no longer applies, for example after the period was raised again.
  - **Notice:** the app shows a notice for each delay, saying how many top-level sessions the cleanup removes and when, with a link to the setting. It remembers the delay it announced (`firstRunAt`) per app profile, so a later delay shows again.
  - **State:** `Global.Path.state/session-retention-<database name>.json`, one per channel database, stores:
    - `firstRunAt`, `pendingFirstRunCount` and `pendingPeriodDays` (the period the delay announced) while a delay is pending;
    - `completedAt` and `periodDays` of the last pass that ran;
    - `holds`.
  - The delay survives restarts. A state file without `periodDays` (written before this rule) gets a first-run check again.
- **Unchanged:** archive and the Cleanup page.

### API

- **Hint data:** `GET /session/retention` (SDK `client.session.retention.get`) returns `{ cleanupPeriodDays, firstRunAt?, pendingFirstRunCount?, expiring: Array<{ sessionID, deletesAt }>, kept: string[], held: string[], syncStale: boolean }`.
  - `expiring` lists non-exempt root sessions due within 3 days. While a delay is pending, `deletesAt` is at least `firstRunAt`.
  - `kept` lists the root sessions with `keep: true`. The app's session list carries no metadata, so the sidebar reads Keep from here. A Keep set on another machine shows after the next retention event.
  - `held` lists the root sessions a schedule protects: a hold that has not lapsed, or an unexpired job in this database (before its hold is written).
  - `syncStale` is true while passes skip their deletions because hub sync has not caught up (see [Sync](#sync)).
  - The app uses it for the hints, the pins, the notice and the settings row.
  - It is served locally and never proxied to a workspace.
- **Keep toggle:** `PATCH /session/{id}/keep { keep: boolean }` (SDK `client.session.keep`).
  - It returns the updated session, 400 for a sub-agent session and 404 for a missing one.
  - A new route was needed because `PATCH /session/{id}` replaces `metadata` wholesale.
  - The write goes through `Session.updateMetadata`, under the session's write lock (see [Sync](#sync)).
- **Event:** `session.retention.updated`, with empty properties, is published on the global bus after every pass, a Keep toggle or a change to `cleanupPeriodDays`. The app refetches when it arrives.

### Schedules

- **Problem:** scheduled jobs (`session_schedule`) are local to one database and never sync.
- **Hold:** while a tree has an unexpired job in this database, the leader sets `retentionHold: true` and `retentionHoldUntil` (now + 7 days) in the root's metadata. The flags sync with the session, and every machine treats an unlapsed hold like Keep.
- **Refresh and expiry:** the leader checks its holds on every hourly pass and rewrites one once it is a day old, so a hold whose job lasts never lapses. Each rewrite moves the chat's sync version, so it is written daily rather than hourly to keep the chat from re-syncing every hour.
  - A hold lapses 7 days after its last refresh. Then it no longer protects the tree anywhere, even if its flags stay in the metadata.
  - This covers a hold whose machine was retired or reinstalled, lost its state file (`holds`), or holds a one-shot wakeup that never fires: such a hold used to stay forever.
  - A hold synced from another machine is never refreshed or cleared here.
- **Clearing:** the leader clears both flags once the tree's last job here is gone or expired.
  - It clears only holds it set. The roots it holds are recorded in the state file's `holds`.
  - When jobs on two machines hold one tree and one ends, the other machine sets the hold again on its next pass.
- **Timing:** the leader reconciles holds at the start of every pass, so a hold appears or clears within an hour.
  - A tree is new or active when its job is created, so the hour's lag does not expose it.
- **Writes are merge-safe** (`SessionRetentionQuery.hold`):
  - **Only after a fresh sync:** hold writes (set, refresh, clear) run only when hub sync is not set up, or a sync cycle caught up with the hub within the last 10 minutes (`HOLD_SYNC_FRESH_MS`). A machine that wakes after a day asleep writes no hold before its first caught-up cycle has pulled what the others wrote.
  - **Metadata only:** one SQL statement patches `retentionHold` and `retentionHoldUntil` into the stored metadata JSON. `Session.updateMetadata` is not used: it publishes the whole session from an earlier read, and its projector rewrites the whole row, which could undo a title, a sync apply or another process's write that landed in between. The statement touches no message, part or other column.
  - **Never newer than unseen writes:** the statement sets the session's `time_updated` to the chat's newest write here plus 1 ms, not to the wall clock. The hold reaches every machine that has this copy (its version is 1 ms newer), but it cannot make this copy newer than messages another machine wrote that this one has not pulled: under the whole-chat rule those messages are newer and win, and the refresh is simply redone on the next day's pass on the merged copy. So a hold write never overwrites another machine's newer messages.
  - The writes emit `session.updated` on the GlobalBus so open clients redraw.
  - **Until sync catches up** the job's tree is still safe on this machine: the job exempts it from retention here, and the sync manifest marks its sessions `scheduled`, so no peer's retention tombstone deletes this machine's copy (see [Sync](#sync)).
- **UI:** held trees show the Keep pin with the tooltip "Held by a schedule" (see [What the user sees](#what-the-user-sees)).
- **Gap:** a machine that only runs `serve` has no retention leader, so its jobs set no hold. Its manifest still marks the job's sessions `scheduled`, so its own copy is never deleted by sync.

### Sync

- **Tombstone basis:** a retention deletion records its basis, the tree's latest activity, and the tree's root.
  - Sync compares a peer's activity against `time_deleted`. A retention tombstone stamps `time_deleted = basis + 1 ms` instead of the wall-clock deletion time, and `root_id` = the deleted tree's root (migration `20261028161358_session_tombstone_root`).
  - Mechanism: `SessionProjector.TombstoneBasis` (`{ latest, root }`) is provided around the delete. Projectors run inside the publishing fiber, so every member's tombstone carries the basis and the root.
  - The sync manifest lists a tombstone's `root` when it has one, and a peer's delete carries it to the tombstone the receiver writes, so it travels on through the hub.
  - Manual deletes keep the wall-clock time, no root, and the per-session rule below.
- **Tree-atomic judgement** (`sync-decide.ts`, `retention`): a retention deletion is judged against its whole tree, never one session.
  - **A deletion's tree, on each side:** every session that side has whose topmost present ancestor is the root the tombstones name, or a member one of the deletion's tombstones covers, or whose missing parent is such a member. So a side that lacks a middle session (it has the grandchild G but not its parent C) still places G in the tree.
  - **Basis:** the oldest `time_deleted` among the deletion's tombstones on either side.
  - **Survives** when, on either side:
    - a member is kept (Keep or an unlapsed hold in its metadata, which the manifest reports as `kept`), or its sync version is at or after the basis: activity the deleter never saw;
    - a member has an unexpired scheduled job on that machine (the manifest's `scheduled`). This protects only that machine's own copy: it is no evidence for the others until the job's hold syncs;
    - or a side that holds the tree (has a member, or a tombstone of the deletion) lacks a member the other side knows: no session and no tombstone of any kind for it. An unknown member is one the deleter never judged, so it counts as survival.
  - A tree nobody touched since, that nobody keeps, holds or schedules, and that both sides know whole, is still deleted whole everywhere.
  - **Manual deletes stay per session:** a peer copy updated after `time_deleted` outranks that session's tombstone only. A deleted sub-agent session therefore does not come back because its root was used later.
  - **Why per tree:** the basis is per tree, but most sub-agent sessions are older than their root's latest activity. Judged per session, a tree active on a peer kept its root and lost every untouched sub-agent session on every machine (and newer activity in a sub-agent session lost the root), leaving task parts pointing at nothing and orphans hidden from the UI.
- **Survival is sticky and whole-tree.** A machine that learns a deletion's tree survived drops every tombstone of that deletion (`root_id` = the root) in one step, and so never deletes those members again for it:
  - **From a manifest comparison:** at the start of every cycle the sync worker asks its local server to void each local deletion whose tree survives (`voids`, then `POST /flynncode-sync/void/:root`, loopback only). `decide` and `decidePush` already treat those tombstones as void in the same cycle.
  - **From a pull or a push:** `MachineSyncStore.apply` finds the deletion the incoming chat belongs to (its own tombstone, or the nearest deleted ancestor's). If the deletion never judged that chat, or the chat's tree here is now newer than the basis, kept, held or scheduled, every tombstone of the deletion goes in the same transaction. This is how the hub learns: it has no worker, and the gateway forwards no new route to it.
  - **Archived members travel with their tree:** a peer-archived chat missing here is pulled when its parent is here or comes in the same cycle, and a local archived chat the hub lacks is pushed when its parent is on the hub or goes there in the same cycle. A deleting machine also pulls back every member of a tree it voids in that cycle, an archived root included. Archived chats outside a tree still stay local.
- **A surviving tree goes back to the hub evidence first** (`decidePush`, `returnTree`). For a surviving tree the hub still holds the deletion's tombstones for:
  - If the hub itself shows the tree newer or kept, every member just goes back.
  - Otherwise the members that carry the evidence go first: written at or after the basis, kept, or unknown to the deleter. One of them on the hub makes the hub drop the whole deletion, and makes the deleting machine see the survival and void its own tombstones; a member joins its tree on either side through its own or its parent's tombstone, so it needs no ancestors.
  - The sync worker sends that evidence outside the 20-chat batch, then re-reads the hub's manifest. Only when every piece of evidence was applied and the hub no longer holds the deletion's tombstones does the rest of the tree follow, in the same cycle and also outside the batch. Otherwise the rest waits for the next cycle, since the deleting machine would delete half a tree again.
  - With no evidence to send (the tree survives on this machine only for a local job), or while a piece of evidence is running, the members the hub lacks stay here.
  - **Result:** a surviving tree of any size is back on the hub in one cycle of the machine that has it, and on the deleting machine in its next cycle. Before this, the peer pushed a tree 20 members at a time in table order, the deleter deleted every batch that did not yet contain the evidence, and a tree with 20 or more members ahead of its evidence looped push/delete every minute for up to 30 days while starving the peer's other pushes.
- **Retention deletes are never split:**
  - **Pushes:** the deleting machine pushes a deletion's member deletes to the hub outside the 20-chat batch.
  - **On a spoke:** the sync worker applies a peer's retention deletes for one tree in one local transaction (`MachineSyncStore.removeTree`, `POST /flynncode-sync/delete-tree/:root`, loopback only). It is refused whole when any member changed since the worker read the manifest, or when the whole tree here (walked up to its top and down to every member) has activity at or after the basis, is kept or held, or has a job.
  - **On the hub:** the per-member delete route (`POST /flynncode-sync/delete/:id`, unchanged on the wire) re-checks the whole tree the same way for a delete that carries a `root`, and answers `stale` when it survives.
  - **Write after the manifest read (re-check chosen over sticky survival):** a write that lands in any member after the worker read its manifest keeps every member: the tree transaction re-reads the whole tree under the same lock it deletes with. Relying on sticky survival on the next cycle would not do: the untouched members would already be gone from every machine by then.
  - **Pulls:** the sync worker's batch takes whole trees only (every pulled chat under one top session of the peer's manifest). A tree larger than the batch is pulled alone, whole, in one cycle. A machine therefore never holds part of a tree because a batch was cut, which is what used to let a machine use a root it had pulled without its sub-agent sessions while another machine deleted them.
- **What stays possible:** a member is lost everywhere only when the machines that had it judged the tree untouched and deleted it, while the machine that kept using the tree never had that member: its pull failed persistently, or the member was created while that machine was away for longer than the retention period. The surviving machine keeps the rest of the tree, and its task part points at nothing. A machine whose pull keeps failing is not caught up, so its own retention is paused, but that does not stop the others.
- **Rollout:** `decide`, `voids` and `decidePush` run in the desktop's sync worker, and the voiding apply and the tree re-check in each server, the hub's included, so the rule ships in the deb and the hub image (see [Deploying](#deploying)).
- **Tombstone expiry:** `session_tombstone.time_recorded` (migration `20261028152423_session_tombstone_recorded`) records when the row was written.
  - Tombstones are pruned 30 days after `time_recorded`, or after `time_deleted` for rows from before the column existed.
  - Without it, a retention tombstone, whose basis is already older than the period, would be pruned at once.
  - A tombstone a peer's delete writes records its arrival time.
- **Freshness (stale sync):** passes skip their deletions (`skipped: "sync-stale"`, logged) while hub sync is set up and no cycle caught up with the hub in the last 24 hours.
  - **Caught up:** a cycle in which every pull it found was applied: none left for a later batch (a cycle pulls at most 20), none skipped because a chat was running on either side, changed meanwhile or waited for its parent. A cycle that only ran is not enough: after a long trip, the first cycles pull the backlog 20 chats at a time while newer copies of what retention would delete are still queued.
  - The sync worker keeps `SyncStatus.lastCaughtUp` in memory. After every cycle the sidecar calls `SessionRetention.recordSync({ paired, lastCaughtUp })`, which writes `Global.Path.state/session-retention-sync-<database name>.json` when the value changes. Every process that leads retention on that database, the TUI included, reads it.
  - **On start**, before it enables retention, the sidecar records `{ paired, lastCaughtUp: null }`: a paired machine counts as stale until its first cycle catches up, never as unpaired. If that write fails, retention stays off. A record that says paired without `lastCaughtUp`, or an unreadable record, counts as stale.
  - **No record at all** means sync was never set up on this machine (a TUI-only install), and passes run.
  - **Reported:** while passes skip for a stale sync, the leader logs a warning once a day ("automatic session cleanup is paused until hub sync catches up", naming a chat that keeps failing to sync or stays busy as the usual cause), and `GET /session/retention` returns `syncStale: true`, so the settings row says "Automatic cleanup is paused until sync catches up". A pull that always fails, for example a bundle that never applies, keeps a machine stale for good; this makes it visible instead of silent.
  - **Paused sync** counts as unpaired, so passes run while the user has paused sync. This is safe: the deletions stay local until sync resumes, and their tombstones carry the basis and are judged per tree then. A tombstone pruned after 30 days paused no longer propagates, and the hub's copy simply comes back.
- **Whole-chat conflicts:**
  - Sync replaces a whole chat with the newer copy. A Keep or hold set on machine A is lost if machine B writes the same session again before the next cycle: B's newer copy, without the flag, wins on A.
  - The pin then disappears, and the tree can later be deleted. This is not fixed. The user docs tell the owner to check the pin after the next sync.
- **Write lock:** `Session.updateMetadata` takes a per-session lock that every `Session` write in the process shares, so a Keep or hold never drops another key this process writes concurrently. Writers in other processes on the same database are not covered.
- **Orphans:** a session whose parent is missing locally belongs to no tree retention can see whole, so retention never deletes it. Sync judges it as the top of its own tree.

## Error handling

- **Isolation:** a failing pass is logged and retried on the next hour. A failure deleting one tree is logged, and the pass continues with the others. A failure writing a hold is logged and retried on the next pass.
- **Bad config:** an invalid `cleanupPeriodDays` (non-integer or below 1) fails config validation with a clear message, and retention does not run until it is fixed. It never falls back to deleting with a guessed value.
- **Clock skew:** a tree whose latest activity is in the future is treated as active.
- **Sync (accepted risks):**
  - **Unsynced Keep:** a Keep that has not synced yet does not stop a machine with an older copy from deleting its own copy of the tree.
    - The machine that set the Keep never deletes the tree: a retention tombstone never deletes a tree kept where it lands. Its copy goes back to the hub, evidence first, and every machine that deleted it pulls the whole tree back, archived members included.
    - Until then the session is missing on the machines that deleted it.
  - **Lost Keep:** a Keep can be lost to a whole-chat conflict (see [Sync](#sync)). The tree is then deleted like any other.
  - **Activity not seen:** a deletion never removes another machine's tree that has activity the deleting machine did not see, anywhere in the tree: the basis and the per-tree judgement keep it, and the deleting machine gets it back. The stale-sync skip keeps a machine that is behind from deleting at all, so this costs a re-download only in the rare case that remains (activity written after the last caught-up cycle).
  - **Unknown members cost a round trip:** a tree that survives only because one side lacked a member comes back whole to the deleting machine, which deletes it again, now whole, on a later pass.
  - **Partial trees:** see "What stays possible" under [Sync](#sync).
  - Both remaining risks are documented as "Keep a session before its last day".

## Testing

All tests use the real database and an injectable clock, with no mocks.

1. **Inactivity:** a tree older than N days is deleted, children included. A tree with any recent descendant activity is kept.
2. **Exemptions:** `keep: true` or an unlapsed `retentionHold` on the root exempts the tree. So do an active schedule and a running background shell.
   - **Busy:** a running turn, a pending permission or question, or an unfinished latest assistant message in the database. A newer assistant message ends an older unfinished one.
   - **V2 in another process:** an open latest V2 assistant message or an unpromoted V2 input keeps the tree; a newer completed V2 assistant message ends an older open one.
3. **Pass cap:** at most 50 trees are deleted per pass.
4. **Surges:**
   - More than 20 eligible trees delays the first pass by 24 hours, and the delay survives a restart. 20 or fewer runs immediately.
   - A first pass with nothing to delete does not spend the delay.
   - Lowering the period so that more than 20 trees become newly eligible delays the pass and announces it. 20 or fewer runs immediately. Raising the period again drops the delay.
   - During a delay, trees aging into the announced period only recount it; lowering the period again so that more than 20 further trees are due restarts the delay with a new `firstRunAt`, and the old time deletes nothing.
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
    - A root R with sub-agent session C, against the real `decide`/`decidePush` and the real manifest: the peer touched only R, the newer activity is only in C, or the peer keeps or holds the tree with nothing newer. In each case no member is deleted on the peer, no delete is pushed, and the deleter pulls R and C back. Untouched, both are deleted everywhere.
    - The same three scenarios and the untouched tree through the real sync worker (mobile-gateway `sync-retention-e2e.test.ts`), with the laptop syncing first so its deletes reach the hub before the desktop's newer copy: every machine ends with the whole tree, or without it.
    - `decide` unit cases: a member kept when the tree is newer on the side that still has the root, a running tree waits, an archived member comes back, and a manual delete stays per session.
    - The manifest marks kept and held trees (not a lapsed or unstamped hold), and tombstones carry their root through the sync delete route.
    - A V2 input admitted out of time order dates the tree exactly as the manifest dates the chat.
    - A stale sync skips the pass, and an unpaired machine runs. A cycle with pulls left for later, or a pull skipped as busy, does not count as caught up. The sidecar records a paired machine as not caught up on start, and a paused sync as unpaired. `GET /session/retention` reports `syncStale`, and the settings row says cleanup is paused (app helper and copy, browser suite).
    - A schedule sets a hold with an expiry, which protects the tree like Keep, is refreshed once a day, and only the machine that set it clears it. A hold nobody refreshes lapses after 7 days, and the tree is deleted.
    - Hold writes wait for a caught-up sync within 10 minutes, patch only the metadata (a title written meanwhile by another writer stays, messages are untouched), and move the version to the chat's newest write plus 1 ms, so a peer copy with newer messages still wins `decide`. The manifest marks a session with a local job `scheduled`.
    - Through the real sync worker (`sync-retention-e2e.test.ts`, whose stores mirror the server's apply, delete, tree-delete and void): a 26-session tree whose newer copy is the root, last in the desktop's table order, and one whose newer copy is its 25th sub-agent session, both converge within two rounds (in fact one) with no member deleted again anywhere and no tombstone left; an evidence push the hub refuses keeps the rest of the tree on the desktop with nothing re-deleted, and the tree converges once it goes through; a newer grandchild whose parent the desktop never had keeps its root everywhere; a machine that lacks a member never deletes it from the others and takes the whole tree back; an archived member goes back to the machine that deleted it. With the previous `sync-decide.ts` and `sync-worker.ts`, all five new cases fail.
    - `decide`/`decidePush` unit cases: the deleter voids every tombstone of a surviving deletion; evidence goes first and the rest after it; a tree kept only by a local job is neither deleted nor pushed; running evidence holds the tree back; a lacking side keeps the tree; a newer grandchild without its parent keeps the root; an archived chat travels with its tree. The worker pulls a tree larger than the batch whole.
    - Store: a write after the manifest read refuses the tree delete whole (also for a delete pushed one member at a time); a tree with a local job is refused; an untouched member coming back voids nothing, a newer one or one the deletion never judged voids the whole deletion; the routes validate `delete-tree` and `void`.
    - Expired tombstones are pruned by recorded time.

## Deploying

The tree-atomic fix (ea3fc3689e) added the migration `20261028161358_session_tombstone_root`, which changed the sync schema id (the newest migration id). A spoke and the hub on different schema ids stop every cycle at `phase: "mismatch"` before deciding anything, so nothing is deleted or applied, but nothing syncs either until both run a build with it. The convergence fix that followed adds **no migration**: the schema id is unchanged, so a build from before it and a build with it sync with each other without a mismatch. That makes the order below matter more, not less: an old spoke still pushes a surviving tree 20 members at a time and an old hub neither drops a deletion when the evidence arrives nor re-checks the tree on a delete.

Roll out in this order:

1. **Back up the hub PVC.** Run the sync hub's backup CronJob by hand and confirm the backup completed.
2. **Rebuild and roll out the hub image from the same commit as the debs.**
   - Server image `flynncode-sync-hub` from `packages/flynncode/Dockerfile.hub`. It carries both tombstone migrations, which run on boot, the hub exclusion from retention, the voiding apply and the tree re-check on deletes.
   - Gateway image `flynncode-sync-gateway` from `packages/mobile-gateway/Dockerfile.hub`, from the same commit. It only forwards the hub routes, which did not change (the new `delete-tree` and `void` routes are loopback only and never forwarded), so a rebuild is optional but keeps the images in step.
   - Keep `SYNC_HUB_MODE=1` in `k8s/sync-hub/statefulset.yaml`. It keeps the hub out of retention and makes it accept the spokes' writes.
3. **Install the deb on every machine.** Build it from that commit in `packages/desktop` with `OPENCODE_CHANNEL=dev` (`bun run build`, then `bun run package:linux --linux deb`) and check `InstallationChannel = "dev"` in its `app.asar`. A machine on a build from before the tree-atomic migration shows "mismatch" and does not sync until it is upgraded. A machine on a build between that migration and this fix keeps syncing, with the old push/delete loop for large surviving trees: upgrade every machine in one go, and do not leave such a build running against the hub.
4. **If a later fix adds another migration, rebuild the hub image again from that commit** before handing out debs, and repeat steps 1 to 3.

## Out of scope

- Per-project retention periods.
- A "local only" retention mode that does not propagate.
- Bulk "delete archived" actions.
