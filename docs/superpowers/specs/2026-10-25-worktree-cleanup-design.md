# Worktree Cleanup Design

Date: 2026-10-25
Status: approved design, pending implementation plan

## Problem

Coding agents running in Flynncode leave worktrees and scratch output behind,
and nothing removes them.

- On 2026-10-25, rl-edge-dev's `.worktrees/` held 55 GB in about 30 folders:
  - 12 registered worktrees of rl-edge-dev (agent `task/*` branches, about 13 GB). Agents were still creating new ones hourly.
  - 11 worktrees of nested repos (rl-common, rl_idx_service, webapp, rl-test-generator, account_service), registered in their own repos, about 43 GB.
    - 41 GB of this was a single `pytest-of-yeager1977/` temp folder: pytest's output landed in the worktree because agents keep temp files off the quota-limited `/tmp`.
  - 7 plain scratch folders that are not worktrees (scripts, logs, batch IDs), about 1 GB.
- Flynncode's own task worktrees (`<repo>/.opencode/worktrees`) are removed only on archive or keep-N retention.
  - Deleting a session never removes its worktree.

This spec covers worktrees and the junk inside them. History-database
retention has its own spec (2026-10-25-history-db-retention-design.md);
session retention and UI responsiveness are separate follow-ups.

## Decisions

1. **Auto-clean what is provably safe; list the rest for approval.**
2. **Safe rule:** a worktree is auto-removed only when all of these hold:
   - it is clean;
   - its HEAD is merged into the repo's default branch or fully pushed;
   - it has been idle for 3 days;
   - no Flynncode session is using it.

   The branch ref is always kept; only the checkout folder is removed.
3. **Junk:** in worktrees idle for 3+ days, auto-delete these, then re-evaluate the worktree:
   - temp output: `pytest-of-*`;
   - tool caches: `.pytest_cache`, `__pycache__`, `.mypy_cache`, `.ruff_cache`, `.turbo`, `coverage/`;
   - empty folders.

   Scratch folders without `.git` are never auto-deleted.
4. **Architecture:** a server-side `WorktreeJanitor` service in `packages/flynncode`, with HTTP routes and a Cleanup page in the app.

## Design

### Hourly scan and auto-clean

The janitor starts 2 minutes after server launch, repeats hourly, and runs one scan at a time.

**Discovery.** For every project in Flynncode's project list:
- each direct child of `<root>/.worktrees/` and `<root>/.opencode/worktrees/`;
- every worktree in the project repo's `git worktree list --porcelain`.

A folder whose `.git` is a file pointing at `<repo>/.git/worktrees/<name>` is a worktree of that repo. This covers nested repos whose worktrees live in the parent's `.worktrees/`. A folder without `.git` is a scratch folder. A main checkout (where `.git` is a directory) is never a candidate.

**Idle.** A worktree is idle when all of these hold:
- the worktree's git `index` file is 3+ days old (mtime);
- its git `logs/HEAD` file is 3+ days old (mtime);
- its HEAD commit (committer date) is 3+ days old;
- no Flynncode session whose `directory` is the worktree or inside it is busy;
- no such session, and none of its messages or parts, was updated in the last 3 days.

Cheap git metadata stands in for walking the files: any edit to a clean worktree would make it dirty, so it would not qualify anyway.

**Junk pass.** Only inside idle worktrees (never in a scratch folder or a main checkout):
- delete the junk names above at any depth;
- never descend into `.git` or `node_modules`;
- then delete folders left empty.

**Auto-remove.** An idle worktree is removed when all of these hold:
- `git status --porcelain` is empty;
- HEAD passes one of these checks:
  - it is an ancestor of the default branch. The default branch is `refs/remotes/origin/HEAD`, falling back to the first of `dev`, `main` or `master` that exists locally or on origin.
  - its upstream exists and `git rev-list @{u}..HEAD` is empty.
  - `git branch -r --contains HEAD` is non-empty.

Removal runs `git -C <repo> worktree remove <path>` without `--force`, so git refuses anything dirty (a second safety check), then `git worktree prune`. The branch is kept.

**Review list.** Everything not auto-removed is listed with one of these reasons:
- `dirty`: uncommitted or untracked changes, with a file count;
- `unpushed`: commits not on any remote or default branch, with a commit count;
- `scratch`: no `.git`;
- `recent`: not idle yet;
- `error`: the scan of that item failed.

**Flynncode task worktrees on delete.** Deleting a session disposes of its disposable task worktree the same way archiving does (`disposeArchivedWorktree` → `Worktree.disposeIfIdle`).

### API and Cleanup screen

**Routes.** These live on the Flynncode server `HttpApi`; regenerate the client with `bun run generate` in `packages/client`.
- `GET /worktree/cleanup` returns the latest scan:
  - `items`: the review list. Each item has `path`, `project`, `repo`, `branch`, `bytes`, `lastActivity`, `reason`, `detail`.
  - `cleaned`: auto-cleaned entries from the last 7 days, each with `path`, `bytes` and `time`.
  - `scanning` (boolean) and `lastScan` (time).
- `POST /worktree/cleanup/remove { paths: string[] }` removes approved items:
  - a worktree: `git worktree remove --force`, then prune; the branch is kept;
  - a scratch folder: deleted recursively.
  - A path is accepted only if it is on the current review list. Any other path is rejected.
  - It returns per-path results.
- `POST /worktree/cleanup/scan` starts a rescan.

**Screen.** A "Cleanup" page (route `/cleanup`) with a sidebar row next to "Usage", built the same way as the Usage page.
- The header shows the total reclaimable size and a "Scan now" button.
- Review items are grouped by project. Each shows size, age, branch and a reason badge; dirty and unpushed items show their counts.
- You select rows with checkboxes and click "Remove selected". A confirm dialog lists what will be lost (uncommitted changes, unpushed commits) before removal.
- A collapsed "Cleaned automatically" section shows the last 7 days.

**Sizes.** Sizes are measured by walking the folder, capped at 30 seconds per item, and cached between scans by path. A capped size is shown as "≥ N".

## Error handling

- A failing scan or removal never takes down the server. Each project and item is handled on its own: an error is logged with its path and listed with reason `error`.
- Path safety:
  - Auto-clean and manual removal act only on paths inside a project's `.worktrees/` or `.opencode/worktrees/`, or on worktrees git lists for that repo.
  - Never a main checkout and never a symlink.
  - Every path is `realpath`-resolved and checked against those roots immediately before deletion.
- Auto-remove never uses `--force`, and a busy session's directory is always skipped.
- One scan at a time per process. The remove endpoint waits for a running scan to finish. A worktree created mid-scan is `recent` and left alone.
- `OPENCODE_DISABLE_WORKTREE_CLEANUP=1` disables the hourly auto-clean. The Cleanup screen still works for manual removal.

## Testing

These run in `packages/flynncode` against real temporary git repos and worktrees, with no mocks. Idle age is set with `utimes` and `GIT_COMMITTER_DATE`, not by waiting.

1. A clean, merged worktree idle for 3+ days is removed and its branch kept. The same worktree when recent is kept.
2. A pushed-but-unmerged worktree (a bare repo as the remote) is auto-removed. One with unpushed commits is listed as `unpushed`.
3. A dirty worktree is listed as `dirty` and never removed.
4. A `pytest-of-*` folder and caches in an idle worktree are deleted; the worktree then becomes clean and is removed. A scratch folder is listed as `scratch` and kept.
5. A nested repo's worktree inside the parent's `.worktrees/` is classified by its own repo.
6. The remove endpoint rejects a path that is not on the review list, and removes a listed dirty worktree with `--force` while keeping its branch.
7. Deleting a session disposes of its disposable task worktree.
8. The Cleanup page renders review items and sends the selected paths (app browser test suite).

## Out of scope

- History-database retention (own spec, implemented).
- Session retention and UI responsiveness (own specs).
- Changing where agents create worktrees or temp files.
