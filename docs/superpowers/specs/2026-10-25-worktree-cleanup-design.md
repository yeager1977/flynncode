# Worktree Cleanup Design

Date: 2026-10-25
Status: implemented; this document matches the implementation

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
   - it sits directly under a project's `.worktrees/` or `.opencode/worktrees/`;
   - it is clean, counting untracked files and tracked files git is told to skip;
   - its HEAD is merged into the repo's default branch or fully pushed;
   - it has been idle for 3 days and no Flynncode session is using it;
   - it does not check out the default branch, `dev`, `main` or `master`;
   - it holds no ignored local file outside an allow-list of regenerable names (`node_modules`, `dist`, `build`, `out`, `.venv`, caches, `*.pyc` and similar), so `.env` and local config keep it;
   - it contains no nested git repository and no initialized submodule, whose changes and commits git status cannot see.

   Inspection fails closed: any git result that is uncertain turns the item into an `error` review item, never a removal. The branch ref is always kept; only the checkout folder is removed.
3. **Junk:** in worktrees idle for 3+ days, auto-delete these, then re-evaluate the worktree:
   - temp output: `pytest-of-*`;
   - tool caches: `.pytest_cache`, `__pycache__`, `.mypy_cache`, `.ruff_cache`, `.turbo`, `coverage/` (only when git ignores it);
   - folders that this pass emptied.

   Dependency trees (`node_modules`, `.venv`, `venv`, `site-packages`) are never searched, so a package named `coverage` inside a virtualenv is never deleted. Scratch folders without `.git` are never auto-deleted.
4. **Architecture:** a server-side `WorktreeJanitor` service in `packages/flynncode`, with HTTP routes and a Cleanup page in the app.

## Design

### Hourly scan and auto-clean

The janitor starts 2 minutes after server launch, repeats hourly, and runs one scan at a time.

**Discovery.** For every project in Flynncode's project list:
- each direct child of `<root>/.worktrees/` and `<root>/.opencode/worktrees/`;
- every worktree in the project repo's `git worktree list --porcelain`.

Worktrees found only through `git worktree list` (outside the two folders, such as a parked dev checkout) are review-only and never cleaned automatically.

A folder whose `.git` is a file pointing at `<repo>/.git/worktrees/<name>` is a worktree of that repo. This covers nested repos whose worktrees live in the parent's `.worktrees/`. A folder without `.git` is a scratch folder; its size walk also records every folder below it that holds a `.git` entry (file or directory) as a nested repo. A main checkout (where `.git` is a directory) is never a candidate.

**Git commands.** Every git command the janitor runs sets `GIT_OPTIONAL_LOCKS=0`, so the hourly `git status` never refreshes the index: it never takes `index.lock` in a worktree an agent is using, and never bumps the `index` mtime that the idle check reads.

**Idle.** A worktree is idle when all of these hold:
- the worktree's git `index` file is 3+ days old (mtime);
- its git `logs/HEAD` file is 3+ days old (mtime);
- its HEAD commit (committer date) is 3+ days old;
- no Flynncode session whose `directory` is the worktree or inside it has itself, or any of its messages or parts, updated in the last 3 days.

A busy session updates continuously, so this recency check also covers busy; there is no separate busy check.

Cheap git metadata stands in for walking the files: any edit to a clean worktree would make it dirty, so it would not qualify anyway.

**Junk pass.** Only inside idle worktrees (never in a scratch folder or a main checkout):
- find the junk names above at any depth, never descending into `.git`, `node_modules`, `.venv`, `venv`, `site-packages`, junk folders or nested repositories;
- delete only the exact approved candidates: tracked paths (or folders holding tracked files) and nested repos are skipped, and `coverage` is deleted only if git-ignored;
- then remove only the directories this pass emptied, up to but never including the worktree root.

**Auto-remove.** An idle worktree is removed when all of these hold:
- `git status --porcelain` is empty. It runs with `-c status.showUntrackedFiles=all --untracked-files=all --ignore-submodules=none`, and assume-unchanged or skip-worktree files count as dirty. The exception is a skip-worktree file missing on disk: that is how a sparse checkout leaves out files outside its cone, and their content is in HEAD, so it does not count as dirty (it stays in the fingerprint, so a file that reappears changes the item);
- it has no initialized submodule: a gitlink whose folder holds a `.git` entry, or a `modules` folder in the worktree's git dir (the same test git uses to refuse an unforced remove). Submodules are listed in `nested`;
- HEAD passes one of these checks:
  - it is an ancestor of the default branch. The default branch is `refs/remotes/origin/HEAD`, falling back to the first of `dev`, `main` or `master` that exists locally or on origin.
  - its upstream exists and `git rev-list @{u}..HEAD` is empty.
  - `git branch -r --contains HEAD` is non-empty.

Removal runs `git -C <repo> -c status.showUntrackedFiles=all worktree remove <path>` without `--force`, so git refuses anything dirty (a second safety check). The branch is kept. There is no `git worktree prune` afterwards: `worktree remove` already drops the registration, and a prune would also drop the registrations of worktrees that are only missing for now (an unmounted disk, a cleared tmpfs). If git refuses, the item is listed as `error`.

**Review list.** Everything not auto-removed is listed with one of these reasons:
- `dirty`: uncommitted or untracked changes, ignored local files, a nested repo or an initialized submodule;
- `unpushed`: commits not on any remote or default branch;
- `scratch`: no `.git` (with `nested` listing any repos inside it);
- `recent`: in use or not idle yet, or kept without risk (outside the cleanup folders, or on a default or long-lived branch);
- `error`: the scan of that item failed, or git refused to remove it.

Each worktree item also lists everything a forced removal would delete: `dirty` count, `ignored` count with an example path, `unpushed` count, `detached` (no branch), `head`, and any `nested` repos (nested repositories and initialized submodules); `detail` sums these up. Each item carries a private state fingerprint (HEAD, exact status text, skipped files with stat, ignored files, nested repos; for scratch folders the newest mtime in the whole tree, whether the walk was capped, and the nested repos).

**Flynncode task worktrees on archive or delete.** Archiving or deleting a session disposes of its disposable task worktree through one shared helper, `disposeSettledWorktree`, once every session bound to it is archived or gone. It calls `Worktree.disposeIfSafe`, which never loses work. It skips the instance's own worktree and any loaded directory. It then runs the janitor's fail-closed inspection (`JanitorInspect.inspect` plus the janitor's ignored-file and nested-repo checks). The folder is removed only when the inspection succeeds and finds a linked worktree with no changed files, no non-regenerable ignored files, no nested repos or submodules, and every commit merged, pushed or reachable from another branch, remote-tracking ref or tag. Removal runs `git -c status.showUntrackedFiles=all worktree remove` without `--force`, and the task branch is always kept. Anything else keeps both the folder and the branch, and the worktree then shows on the Cleanup page. `Worktree.remove` (forced, deletes the branch) is unchanged for its explicit callers.

### API and Cleanup screen

**Routes.** These are global routes on `RootHttpApi`, behind the same Authorization middleware as the other root routes; regenerate the client with `bun run generate` in `packages/client`. SDK methods: `client.worktreeCleanup.report()`, `.scan()` and `.remove({ paths })`.
- `GET /worktree/cleanup` returns the latest scan:
  - `items`: the review list. Each item has `path`, `project`, `bytes`, `capped`, `lastActivity`, `reason`, `detail`, `nested` (except items whose inspection failed), and for worktrees `repo`, `branch`, `head`, `detached`, `dirty`, `unpushed`, `ignored`, `ignoredExample`.
  - `cleaned`: entries from the last 7 days (kept in memory, not persisted), each with `path`, `bytes`, `time`, `kind` (`worktree`, `junk` or `scratch`) and `rescued`.
  - `scanning` (boolean) and `lastScan` (time).
- `POST /worktree/cleanup/remove { paths: string[] }` removes approved items and returns `{ results }` with `path`, `ok`, `error` and `rescued` per path:
  - a worktree: `git worktree remove --force` (no prune, as above); the branch is kept;
  - a scratch folder: deleted recursively.
  - A path is accepted only if it is on the current review list and still inside a cleanup root or listed by git for its project.
  - It refuses every item listed as `error` (it could not be inspected, or git refused its removal), whatever the page sends.
  - It re-inspects the item and refuses if anything changed since the scan (fingerprint mismatch), if the item (worktree or scratch folder) holds a nested repo or an initialized submodule, if it is a git-listed worktree without a `.git` file, or if a scratch walk was capped.
  - A detached HEAD with unpushed commits first gets a `janitor/rescued-<sha7>` branch (reused if one already points at the commit), reported as `rescued`.
- `POST /worktree/cleanup/scan` starts a rescan.

**Screen.** A "Cleanup" page (route `/cleanup`) with a sidebar row next to "Usage", built the same way as the Usage page.
- The header shows the total reclaimable size and a "Scan now" button.
- Review items are grouped by project. Each shows size, age, branch and a reason badge; dirty and unpushed items show their counts.
- You select rows with checkboxes and click "Remove selected". `error` and nested-repo rows are disabled. The confirm dialog shows every loss (changed files, ignored local files, unpushed commits removed from the folder while their branches stay, detached HEADs rescued onto `janitor/rescued-…` branches) and flags recently used folders that may still be in use; the page sends exactly the confirmed set. If the selection or its numbers changed while the dialog was open, it refuses and asks again.
- A collapsed "Recently cleaned" section shows the last 7 days, both automatic and manual removals.

**Sizes.** Sizes are measured by walking the folder, capped at 30 seconds per item, and cached between scans by path. A capped size is shown as "≥ N".

## Error handling

- A failing scan or removal never takes down the server. Each project and item is handled on its own: an error is logged with its path and listed with reason `error`.
- Path safety:
  - Auto-clean acts only on paths directly inside a project's `.worktrees/` or `.opencode/worktrees/`. Manual removal also accepts worktrees git lists for that repo.
  - Never a main checkout and never a symlink.
  - Every path is `realpath`-resolved and checked against those roots immediately before deletion.
- Auto-remove never uses `--force`, and a directory in use by a recent session is always skipped.
- One scan at a time per process. The remove endpoint waits for a running scan to finish. A worktree created mid-scan is `recent` and left alone.
- `OPENCODE_DISABLE_WORKTREE_CLEANUP=1` disables the hourly auto-clean. The Cleanup screen still works for manual removal.

## Testing

These run in `packages/flynncode` against real temporary git repos and worktrees, with no mocks. Idle age is set with `utimes` and `GIT_COMMITTER_DATE`, not by waiting.

1. A clean, merged worktree idle for 3+ days is removed and its branch kept. The same worktree when recent is kept.
2. A pushed-but-unmerged worktree (a bare repo as the remote) is auto-removed. One with unpushed commits is listed as `unpushed`.
3. A dirty worktree is listed as `dirty` and never removed.
4. A `pytest-of-*` folder and caches in an idle worktree are deleted; the worktree then becomes clean and is removed. A `coverage` package inside an ignored `.venv` survives. A scratch folder is listed as `scratch` and kept.
5. A nested repo's worktree inside the parent's `.worktrees/` is classified by its own repo. A worktree with an initialized submodule (a real superproject) is held with the submodule in `nested`. A cone sparse checkout with nothing changed is not dirty. Inspection never rewrites a worktree's index.
6. The remove endpoint rejects a path that is not on the review list, refuses a changed, nested-repo (worktree or scratch folder), submodule or `error` item, and removes a listed dirty worktree with `--force` while keeping its branch (and rescues a detached unpushed HEAD). Neither auto nor manual removal drops the registration of a temporarily missing worktree.
7. Archiving or deleting a session removes its disposable task worktree when it is clean with no unique commits, and keeps the branch. A worktree with an uncommitted file, an unmerged commit or a non-regenerable ignored file is kept with its branch.
8. The Cleanup page renders review items and sends exactly the confirmed paths (app browser test suite).

## Out of scope

- History-database retention (own spec, implemented).
- Session retention and UI responsiveness (own specs).
- Changing where agents create worktrees or temp files.
