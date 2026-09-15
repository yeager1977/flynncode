# Flynncode Fork Nightly Sync — Design

Date: 2026-09-14
Status: Approved

## Goal

Maintain `yeager1977/flynncode` as a fork of `anomalyco/opencode` whose `dev`
branch carries the fork owner's changes while automatically staying current
with upstream `dev`. Upstream changes arrive every night; the owner's commits
stay on top.

## Fork Setup (one-time, completed)

- `yeager1977/opencode` was renamed to `yeager1977/flynncode`. GitHub keeps the
  fork link to `anomalyco/opencode`, and the open upstream PRs
  (#48550, #48549, #47307, #47305) were retargeted to the renamed fork.
- Dedicated sync clone at `~/GitHub/flynncode`:
  - `origin` = `https://github.com/yeager1977/flynncode.git` (dev only)
  - `upstream` = `https://github.com/anomalyco/opencode.git` (dev only)
- `dev` seeded from `upstream/dev` plus a merge of the owner's work from
  `~/GitHub/opencode` (`dev` + `flycode`, including `ollama-model-router`).
- `~/GitHub/opencode` is legacy; no further changes are made there.
- Fork branches pruned to `dev` plus the five owner branches:
  `app-sound-bootstrap`, `provider-model-discovery`, `mcp-server-management`,
  `feat/desktop-plugin-manager`, `fix/openai-compatible-model-discovery`.

## Sync Script

`script/sync-flynncode.sh` (committed to the repo).

Behavior:

1. `flock` single-instance lock; exits quietly if another run is active.
2. Refuses to run if `dev` is checked out with uncommitted changes.
3. Refuses to move `dev` if it is checked out in another worktree.
4. Fetches `origin` and `upstream`, then reconciles `dev` with each source:
   fast-forward when possible, merge commit otherwise.
5. If `dev` is not the current branch, the merge happens in a temporary
   worktree; the branch ref is updated atomically with `git update-ref`.
6. On merge conflict: aborts the merge, leaves `dev` at its prior commit,
   sends a notification, exits non-zero. It never resolves conflicts and
   never force-pushes.
7. Pushes `dev` to `origin` only when the local branch differs from
   `origin/dev`.

Environment overrides (defaults in parentheses): `FLYNNCODE_REPO`
(`~/GitHub/flynncode`), `FLYNNCODE_BRANCH` (`dev`), `FLYNNCODE_REMOTE`
(`upstream`), `FLYNNCODE_TARGET_REMOTE` (`origin`), `FLYNNCODE_LOCK`,
`FLYNNCODE_MERGE_LOG`, `FLYNNCODE_WORK_DIR`.

## Scheduling

systemd user units (linger already enabled):

- `~/.config/systemd/user/flynncode-sync.service` — oneshot, runs the script
- `~/.config/systemd/user/flynncode-sync.timer` — `OnCalendar=*-*-* 03:30`,
  `RandomizedDelaySec=30m`, `Persistent=true`

`Persistent=true` means a night missed because the machine was off runs at
the next opportunity. Runs execute without an interactive login.

## Verification

- Script paths exercised in a throwaway harness (local bare remotes):
  no-op, fast-forward, merge commit, conflict abort, worktree mode,
  dirty-tree guard.
- Real-repo checks: repeated manual runs produce a clean no-op after the
  first; `systemctl --user list-timers` shows the next fire time;
  `journalctl --user -u flynncode-sync` shows run logs.

## Notes / Limitations

- Public forks of public repositories cannot be made private.
- Conflicts are surfaced, never auto-resolved; the fork owner resolves them
  manually in `~/GitHub/flynncode` and the next run resumes normally.
- The nightly job does not carry changes from `~/GitHub/opencode` anymore;
  the fork is the single source of truth going forward.
