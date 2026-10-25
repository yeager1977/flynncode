# Worktree Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically remove provably-safe stale worktrees and temp junk across all Flynncode projects, and list everything else on a Cleanup screen for approval.

**Architecture:** A global `WorktreeJanitor` service in `packages/flynncode/src/worktree/janitor/` with three layers: `inspect.ts` classifies one folder with git (worktree/scratch/main, dirty, unpushed, merged/pushed, idle); `junk.ts` deletes known temp/cache folders and measures sizes; `janitor.ts` scans every project hourly, auto-removes safe worktrees, keeps the review list and the 7-day cleaned history in memory, and removes approved items. Global HTTP routes (`/worktree/cleanup`) on the root `HttpApi` feed a new `/cleanup` app page. Deleting a session also disposes its disposable task worktree.

**Tech Stack:** TypeScript, Effect 4 beta, `effect/unstable/process` ChildProcess via `AppProcess` (`@flynncode/core/process`), drizzle `sql` over `Database.Service`, Effect HttpApi, SolidJS + TanStack Query (app), bun test.

**Spec:** `docs/superpowers/specs/2026-10-25-worktree-cleanup-design.md`

## Global Constraints

- Idle threshold: 3 days (`IDLE_MS = 3 * 24 * 60 * 60 * 1000`).
- Auto-remove only when ALL hold: idle; `git status --porcelain` empty; HEAD is an ancestor of the default branch, OR upstream exists and `git rev-list @{u}..HEAD` is empty, OR `git branch -r --contains HEAD` is non-empty. Removal: `git -C <repo> worktree remove <path>` WITHOUT `--force`, then `git -C <repo> worktree prune`. Never delete the branch.
- Default branch: `refs/remotes/origin/HEAD` (via `git symbolic-ref --short refs/remotes/origin/HEAD`), else the first of `dev`, `main`, `master` that exists as a local branch or `origin/<name>`.
- Junk names (deleted at any depth, only inside idle worktrees, never descending into `.git` or `node_modules`): directories named `pytest-of-*`, `.pytest_cache`, `__pycache__`, `.mypy_cache`, `.ruff_cache`, `.turbo`, `coverage`; then empty directories. Scratch folders (no `.git`) are never auto-deleted.
- Discovery roots per project: direct children of `<root>/.worktrees/` and `<root>/.opencode/worktrees/`, plus every path in `git -C <root> worktree list --porcelain` except the main checkout.
- Review reasons: `dirty` (file count), `unpushed` (commit count), `scratch`, `recent`, `error`.
- Path safety: every delete target is `realpath`-resolved and must be inside a discovery root of a known project or be a worktree git lists for that repo; never a main checkout (`.git` is a directory), never a symlink. Manual removal accepts only paths on the current review list.
- One scan at a time per process; remove waits for a running scan. Sizes: walk capped at 30s per item, cached by path between scans; a capped size is reported with `capped: true`.
- Hourly loop starts 2 minutes after launch. Opt-out: `OPENCODE_DISABLE_WORKTREE_CLEANUP` (core Flag) disables the hourly auto-clean only; routes keep working.
- Cleaned history: in memory, entries from the last 7 days.
- Busy sessions: a session counts as in use if its `directory` is the item or inside it and its `session.time_updated` or any of its `message`/`part` rows' `time_updated` is within the last 3 days (a busy session updates continuously, so recency covers busy).
- Repo style (AGENTS.md): no `any`, no import aliases or star imports, `const` over `let` where practical, no `else`, bind Effect services to variables, comments only for non-obvious constraints, self-export pattern (`export * as X from "./file"`). Tests run from package dirs; `bun typecheck` from package dirs. Never write files under `/tmp` yourself (test fixtures that already use os.tmpdir are fine).
- Shared checkout: stage explicit paths only; never `git add -A`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Inspect one folder

**Files:**
- Create: `packages/flynncode/src/worktree/janitor/inspect.ts`
- Create: `packages/flynncode/test/worktree/janitor-inspect.test.ts`

**Interfaces:**
- Produces:
  - `type Inspection = { path: string; kind: "worktree"; repo: string; branch?: string; dirty: number; unpushed: number; safe: boolean; lastActivity: number } | { path: string; kind: "scratch"; lastActivity: number } | { path: string; kind: "main" }`
    - `safe` = clean AND (merged into default OR pushed). `unpushed` = commit count of HEAD not reachable from the default branch or any remote branch (`git rev-list --count HEAD --not <default> --remotes`). `lastActivity` = max of the worktree gitdir's `index` mtime, `logs/HEAD` mtime, HEAD committer time (ms); for scratch, the folder's own mtime and its direct children's mtimes.
  - `JanitorInspect.inspect(path: string): Effect<Inspection, Error>` (requires `AppProcess.Service`)
  - `JanitorInspect.git(cwd: string, args: string[]): Effect<{ code: number; text: string }>` (exported for reuse; never fails — errors become `code: 1`)
  - `JanitorInspect.defaultBranch(repo: string): Effect<string | undefined>`

- [ ] **Step 1: Write failing tests** in `packages/flynncode/test/worktree/janitor-inspect.test.ts`. Read `test/worktree/retention-sweep.test.ts` and `test/fixture/fixture.ts` (`tmpdirScoped({ git: true })`) first and mirror their layer setup (the inspect code needs only `AppProcess` — check `packages/core/src/process.ts` for its node and compile `LayerNode.compile(AppProcess.node)` or whatever the existing tests use for git).

Helpers in the test (plain `Bun.spawnSync` is fine for setup):

```ts
const run = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD },
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}
const OLD_MS = Date.now() - 5 * 24 * 60 * 60 * 1000
const OLD = new Date(OLD_MS).toISOString()
// Backdate the worktree's git metadata so it reads as idle.
const age = (worktree: string) => {
  const gitdir = run(worktree, "rev-parse", "--absolute-git-dir")
  for (const file of ["index", "logs/HEAD"]) utimesSync(path.join(gitdir, file), OLD_MS / 1000, OLD_MS / 1000)
}
```

Test cases (each creates a repo with `main` as its branch — run `git branch -M main` after the fixture's root commit — and a worktree under `<repo>/.worktrees/<name>` via `git worktree add -b <branch> <dir>`):
1. merged + clean → `{ kind: "worktree", safe: true, dirty: 0, unpushed: 0, branch: "<branch>" }` and `lastActivity <= OLD_MS + 1000` after `age()`.
2. one extra commit on the worktree branch not merged, no remote → `safe: false, unpushed: 1`.
3. pushed but unmerged: create a bare repo (`git init --bare <dir>/remote.git`), `git remote add origin <bare>`, push `main`, commit on the worktree branch, `git push -u origin <branch>` from the worktree → `safe: true, unpushed: 0`.
4. untracked file in the worktree → `dirty: 1, safe: false`.
5. folder without `.git` under `.worktrees/` → `{ kind: "scratch" }`.
6. the repo root itself → `{ kind: "main" }`.
7. nested repo: a second repo at `<repo>/inner` (its own `git init`), worktree of `inner` placed at `<repo>/.worktrees/inner-wt` → `kind: "worktree"`, `repo` equals the real path of `<repo>/inner`.

- [ ] **Step 2: Run** `cd packages/flynncode && bun test test/worktree/janitor-inspect.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `packages/flynncode/src/worktree/janitor/inspect.ts`:

```ts
import { AppProcess } from "@flynncode/core/process"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { lstat, readFile, realpath, stat, readdir } from "node:fs/promises"
import path from "path"

export type Inspection =
  | { path: string; kind: "worktree"; repo: string; branch?: string; dirty: number; unpushed: number; safe: boolean; lastActivity: number }
  | { path: string; kind: "scratch"; lastActivity: number }
  | { path: string; kind: "main" }

export const git = Effect.fnUntraced(function* (cwd: string, args: string[]) {
  const proc = yield* AppProcess.Service
  return yield* proc
    .run(ChildProcess.make("git", args, { cwd, extendEnv: true, stdin: "ignore" }))
    .pipe(
      Effect.map((result) => ({ code: result.exitCode, text: result.stdout.toString("utf8").trim() })),
      Effect.catchCause(() => Effect.succeed({ code: 1, text: "" })),
    )
})
```

(Check `AppProcess.Service`'s `run` result shape against `packages/flynncode/src/worktree/index.ts:204-222`, which wraps the same call into `{ code, text, stderr }`; adapt field names exactly as that code does.)

```ts
export const defaultBranch = Effect.fnUntraced(function* (repo: string) {
  const origin = yield* git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  if (origin.code === 0 && origin.text) return origin.text
  for (const name of ["dev", "main", "master"]) {
    const local = yield* git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])
    if (local.code === 0) return name
    const remote = yield* git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])
    if (remote.code === 0) return `origin/${name}`
  }
  return undefined
})

export const inspect = Effect.fn("JanitorInspect.inspect")(function* (target: string) {
  const dir = yield* Effect.promise(() => realpath(target))
  const dotGit = yield* Effect.promise(() => lstat(path.join(dir, ".git")).catch(() => undefined))
  if (!dotGit) return { path: dir, kind: "scratch" as const, lastActivity: yield* Effect.promise(() => folderActivity(dir)) }
  if (dotGit.isDirectory()) return { path: dir, kind: "main" as const }

  // A worktree's .git file points at <repo>/.git/worktrees/<name>; the repo is
  // what git reports as the common dir's parent, which also covers nested repos
  // whose worktrees live in a parent project's .worktrees/.
  const common = yield* git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const gitdir = yield* git(dir, ["rev-parse", "--absolute-git-dir"])
  if (common.code !== 0 || gitdir.code !== 0) return yield* Effect.fail(new Error(`not a git worktree: ${dir}`))
  const repo = path.dirname(common.text)
  const branch = (yield* git(dir, ["symbolic-ref", "--short", "-q", "HEAD"])).text || undefined
  const status = yield* git(dir, ["status", "--porcelain"])
  const dirty = status.text ? status.text.split("\n").length : 0
  const base = yield* defaultBranch(repo)
  const unpushedArgs = ["rev-list", "--count", "HEAD", "--not", "--remotes", ...(base ? [base] : [])]
  const unpushed = Number((yield* git(dir, unpushedArgs)).text || "0")
  const merged = base ? (yield* git(dir, ["merge-base", "--is-ancestor", "HEAD", base])).code === 0 : false
  const upstream = yield* git(dir, ["rev-list", "--count", "@{u}..HEAD"])
  const pushed = (upstream.code === 0 && upstream.text === "0") || (yield* git(dir, ["branch", "-r", "--contains", "HEAD"])).text !== ""
  const committed = Number((yield* git(dir, ["log", "-1", "--format=%ct"])).text || "0") * 1000
  const metadata = yield* Effect.promise(() =>
    Promise.all(["index", "logs/HEAD"].map((file) => stat(path.join(gitdir.text, file)).then((info) => info.mtimeMs, () => 0))),
  )
  return {
    path: dir,
    kind: "worktree" as const,
    repo,
    branch,
    dirty,
    unpushed,
    safe: dirty === 0 && (merged || pushed),
    lastActivity: Math.max(committed, ...metadata),
  }
})

async function folderActivity(dir: string) {
  const entries = await readdir(dir).catch(() => [])
  const times = await Promise.all(
    [dir, ...entries.map((entry) => path.join(dir, entry))].map((file) => lstat(file).then((info) => info.mtimeMs, () => 0)),
  )
  return Math.max(0, ...times)
}

export * as JanitorInspect from "./inspect"
```

Remove the unused `readFile` import if you do not need it. If `let`-free style forces awkwardness anywhere, prefer clarity and note it.

- [ ] **Step 4: Run tests** → 7 pass. **Step 5:** `cd packages/flynncode && bun typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/flynncode/src/worktree/janitor/inspect.ts packages/flynncode/test/worktree/janitor-inspect.test.ts
git commit -m "feat(flynncode): classify worktrees for cleanup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Junk removal and sizes

**Files:**
- Create: `packages/flynncode/src/worktree/janitor/junk.ts`
- Create: `packages/flynncode/test/worktree/janitor-junk.test.ts`

**Interfaces:**
- Produces:
  - `JanitorJunk.JUNK: ReadonlySet<string>` = `.pytest_cache`, `__pycache__`, `.mypy_cache`, `.ruff_cache`, `.turbo`, `coverage`; plus prefix `pytest-of-` (checked by `isJunk(name)`).
  - `JanitorJunk.removeJunk(root: string): Promise<{ removed: string[]; bytes: number }>` — deletes junk dirs at any depth under `root` (skipping `.git` and `node_modules`, never following symlinks), then removes directories left empty (deepest first, never `root` itself). Returns removed paths and bytes freed.
  - `JanitorJunk.size(root: string, input?: { budgetMs?: number }): Promise<{ bytes: number; capped: boolean }>` — sums file sizes with `lstat` (no symlink following), stops when `budgetMs` (default 30_000) elapses and reports `capped: true`.

- [ ] **Step 1: Failing tests** (real temp dirs via the repo's tmpdir fixture):
  1. `removeJunk` deletes `pytest-of-user/x/file`, `pkg/__pycache__/a.pyc`, `.pytest_cache/`, and keeps `src/main.py`, `node_modules/pkg/__pycache__/` (not descended), `.git/` contents; returns the removed paths and bytes > 0.
  2. `removeJunk` removes directories left empty (e.g. `a/b/` that only contained `__pycache__`) but not `root`.
  3. A symlink named `__pycache__` pointing outside root is removed as a link only; the target survives.
  4. `size` returns the byte total of a known tree; with `budgetMs: 0` it returns `capped: true`.

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** with `node:fs/promises` (`readdir(dir, { withFileTypes: true })`, `lstat`, `rm(target, { recursive: true, force: true })`, `rmdir`). Recursion is fine; keep it in this file. Compute bytes freed with `size(target, { budgetMs: Infinity })` before deleting each junk dir. Add a comment that junk is only ever removed inside idle worktrees (the caller enforces it) and why `node_modules` is skipped (huge, needed to run, not junk).

- [ ] **Step 4: Run tests** → 4 pass; `bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/flynncode/src/worktree/janitor/junk.ts packages/flynncode/test/worktree/janitor-junk.test.ts
git commit -m "feat(flynncode): remove temp and cache junk from worktrees

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The janitor service (scan, auto-clean, review list, remove)

**Files:**
- Create: `packages/flynncode/src/worktree/janitor/janitor.ts`
- Create: `packages/flynncode/test/worktree/janitor.test.ts`
- Modify: `packages/core/src/flag/flag.ts` (add `OPENCODE_DISABLE_WORKTREE_CLEANUP: truthy("OPENCODE_DISABLE_WORKTREE_CLEANUP"),` after `OPENCODE_DISABLE_DB_MAINTENANCE`)
- Modify: `packages/flynncode/src/server/routes/instance/httpapi/server.ts` (register `WorktreeJanitor.node` in the `app` LayerNode group, after `SessionDiffSweep.node`)

**Interfaces:**
- Consumes: `JanitorInspect.inspect/git`, `JanitorJunk.removeJunk/size`, `Project.Service.list()` (`packages/flynncode/src/project/project.ts:336`; rows have `worktree` and `sandboxes`), `Database.Service` (`@flynncode/core/database/database`), tables `SessionTable`, `MessageTable`, `PartTable` from `@flynncode/core/session/sql`.
- Produces:
  - `type ReviewItem = { path: string; project: string; repo?: string; branch?: string; bytes: number; capped: boolean; lastActivity: number; reason: "dirty" | "unpushed" | "scratch" | "recent" | "error"; detail?: string }`
  - `type CleanedItem = { path: string; bytes: number; time: number; kind: "worktree" | "junk" }`
  - `type Report = { items: ReviewItem[]; cleaned: CleanedItem[]; scanning: boolean; lastScan?: number }`
  - `WorktreeJanitor.Service` with `scan(): Effect<Report>`, `report(): Effect<Report>`, `remove(paths: string[]): Effect<{ path: string; ok: boolean; error?: string }[]>`
  - `WorktreeJanitor.IDLE_MS`, `WorktreeJanitor.node`

- [ ] **Step 1: Failing tests** in `packages/flynncode/test/worktree/janitor.test.ts`. Build the layer like `test/storage/session-diff-sweep.test.ts` / `test/worktree/retention-sweep.test.ts` with `WorktreeJanitor.node` plus its deps (Project, Database, AppProcess, FSUtil as needed). Register the test repo as a project the same way existing tests do (find how `Project.Service` creates a project row, e.g. `project.fromDirectory(dir)` — grep the tests for it). Reuse the helpers from Task 1's test (copy `run`/`age` into this test file). Cases:
  1. clean merged idle worktree → after `scan()` it is gone from disk, `git branch --list <branch>` still prints it, and `cleaned` has a `worktree` entry for it.
  2. same but not aged (recent) → kept, listed with reason `recent`.
  3. idle dirty (untracked `notes.txt`) → kept, reason `dirty`, `detail` mentions 1 file.
  4. idle with unpushed commit → kept, reason `unpushed`.
  5. idle worktree whose only untracked content is `pytest-of-x/big.bin` → junk removed, then worktree auto-removed; `cleaned` has a `junk` entry and a `worktree` entry.
  6. scratch folder `.worktrees/notes/` with a file → kept on disk, reason `scratch`.
  7. a Flynncode session whose `directory` is the idle clean worktree and whose `time_updated` is now → worktree kept with reason `recent` (insert the session row with raw SQL as `packages/flynncode/test/storage/session-diff-sweep.test.ts` does, using the project id of the registered project).
  8. `remove([dirtyPath])` for a listed dirty worktree → folder gone, branch kept, result `ok: true`; `remove(["/etc"])` → `ok: false` with an error saying it is not on the review list; nothing outside is touched.
  9. `remove([scratchPath])` for a listed scratch folder → deleted.

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** `janitor.ts` (follow `packages/flynncode/src/storage/session-diff-sweep.ts` for the service/layer/loop shape):

```ts
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Flag } from "@flynncode/core/flag/flag"
import { AppProcess } from "@flynncode/core/process"
import { sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Layer, Schedule, Semaphore } from "effect"
import { readdir, realpath, rm } from "node:fs/promises"
import path from "path"
import { Project } from "@/project/project"
import { JanitorInspect } from "./inspect"
import { JanitorJunk } from "./junk"

export const IDLE_MS = 3 * 24 * 60 * 60 * 1000
const HISTORY_MS = 7 * 24 * 60 * 60 * 1000
const ROOTS = [".worktrees", path.join(".opencode", "worktrees")]
```

Behavior (write it as a `Layer.effect` building the service; keep the main `scan` readable and push details into small helpers below it):

- `scan`:
  1. Under a `Semaphore` (1 permit) shared with `remove`; set `scanning = true` while running.
  2. `now = Date.now()`. List projects; for each project root (`worktree`, skip if missing on disk) collect candidates: direct children of each of `ROOTS` that exist (directories only, skip symlinks via `lstat`), plus paths from `git -C <root> worktree list --porcelain` (lines starting `worktree `) except the root itself. De-duplicate by `realpath`. Remember for each candidate its project root (for path-safety and grouping).
  3. Load "in use" directories once: `SELECT directory FROM session s WHERE s.time_updated >= ${now - IDLE_MS} OR EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.time_updated >= ${now - IDLE_MS}) OR EXISTS (SELECT 1 FROM part p WHERE p.session_id = s.id AND p.time_updated >= ${now - IDLE_MS})`. A candidate is in use if any of those directories equals it or is inside it (`dir === candidate || dir.startsWith(candidate + path.sep)`).
  4. For each candidate, isolated (an error → review item reason `error`, `detail` = message; log it with the path):
     - `inspect`. `main` → skip. `scratch` → review item `scratch`.
     - worktree: `idle = !inUse && now - lastActivity >= IDLE_MS`. Not idle → review item `recent`.
     - idle → `removeJunk(path)`; record each removed junk path in `cleaned` (`kind: "junk"`); re-`inspect`.
     - idle and `safe` → `git -C <repo> worktree remove <path>` (no `--force`) then `git -C <repo> worktree prune`; on exit code 0 record `cleaned` (`kind: "worktree"`, bytes measured before removal); on failure → review item `error` with git's message.
     - idle and not safe → review item `dirty` (`detail: "<n> changed files"`) if `dirty > 0`, else `unpushed` (`detail: "<n> unpushed commits"`).
     - Review items carry `bytes`/`capped` from `JanitorJunk.size` (cache results by path in a `Map` across scans; reuse a cached size if the item's `lastActivity` is unchanged).
  5. Store `items`, prune `cleaned` to the last `HISTORY_MS`, set `lastScan = now`, `scanning = false`. Log one INFO line: candidates, auto-removed worktrees, junk bytes freed, review items.
- `report` returns the stored state.
- `remove(paths)`: under the same semaphore. For each path: it must equal (after `realpath`) a path in the current `items`; otherwise `{ ok: false, error: "not on the cleanup review list" }`. Re-check path safety: inside its project root's `ROOTS` or a git-listed worktree of that project, not a symlink, not a main checkout. Worktree → `git -C <repo> worktree remove --force <path>` + prune (branch kept). Scratch → `rm(path, { recursive: true, force: true })`. Then drop it from `items` and add to `cleaned`. Per-path errors are returned, never thrown.
- Hourly loop: if `Flag.OPENCODE_DISABLE_WORKTREE_CLEANUP` is not set, `scan().pipe(Effect.catchCause(log), Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.delay(Duration.minutes(2)), Effect.forkScoped)`.
- `node = LayerNode.make({ service: Service, layer, deps: [Project.node, Database.node, AppProcess.node] })` — check the exact node names (`AppProcess.node` in `@flynncode/core/process`, `Project.node` in `@/project/project`).

Register `WorktreeJanitor.node` in `packages/flynncode/src/server/routes/instance/httpapi/server.ts`'s `app` group after `SessionDiffSweep.node`.

- [ ] **Step 4: Run tests** → 9 pass. Also run `bun test test/server/httpapi-cors.test.ts` (app still boots) and `bun typecheck` in packages/flynncode and packages/core.

- [ ] **Step 5: Commit**

```bash
git add packages/flynncode/src/worktree/janitor/janitor.ts packages/flynncode/test/worktree/janitor.test.ts packages/core/src/flag/flag.ts packages/flynncode/src/server/routes/instance/httpapi/server.ts
git commit -m "feat(flynncode): clean stale worktrees hourly and keep a review list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: HTTP routes and SDK

**Files:**
- Create: `packages/flynncode/src/server/routes/instance/httpapi/groups/worktree-cleanup.ts`
- Create: `packages/flynncode/src/server/routes/instance/httpapi/handlers/worktree-cleanup.ts`
- Modify: `packages/flynncode/src/server/routes/instance/httpapi/api.ts` (add to `RootHttpApi` with `.addHttpApi(...)`, next to the global API, l.60-65)
- Modify: `packages/flynncode/src/server/routes/instance/httpapi/server.ts` (provide the handler layer next to `globalHandlers`, ~l.161)
- Regenerate: legacy SDK via `./packages/sdk/js/script/build.ts` (writes `packages/sdk/openapi.json` and `packages/sdk/js/src/v2/gen/*`)
- Test: `packages/flynncode/test/server/worktree-cleanup-httpapi.test.ts`

**Interfaces:**
- Consumes: `WorktreeJanitor.Service` (`report`, `scan`, `remove`), types `ReviewItem`, `CleanedItem`, `Report`.
- Produces (OpenAPI identifiers → SDK methods):
  - `GET /worktree/cleanup` → identifier `worktreeCleanup.report` → `client.worktreeCleanup.report()`; success schema mirrors `Report`.
  - `POST /worktree/cleanup/scan` → `worktreeCleanup.scan` → returns `Report`.
  - `POST /worktree/cleanup/remove` with payload `{ paths: string[] }` → `worktreeCleanup.remove` → `client.worktreeCleanup.remove({ paths })` returns `{ results: { path, ok, error? }[] }`.

- [ ] **Step 1: Failing test.** Mirror an existing global-route HttpApi test (find one: `grep -rln "global.upgrade\|routinesRuns\|GlobalPaths" packages/flynncode/test | head`). Test that `GET /worktree/cleanup` returns `{ items: [], cleaned: [], scanning: false }` shape on an empty data dir, and `POST /worktree/cleanup/remove { paths: ["/etc"] }` returns a result with `ok: false`. Use the same auth/headers the existing test uses.

- [ ] **Step 2: Run** → FAIL (404 / missing).

- [ ] **Step 3: Implement** the group following `groups/global.ts` exactly (paths constant, `Schema.Struct` payload/success, `described(...)`, `OpenApi.annotations({ identifier })`, the same middleware the global group uses), and the handler following `handlers/global.ts` (yield `WorktreeJanitor.Service` once at the top; `Effect.fn("WorktreeCleanupHttpApi.report")(...)` etc.). Wire into `api.ts` and `server.ts` as described. Schemas: define `ReviewItem`, `CleanedItem`, `Report`, `RemoveInput`, `RemoveResult` with `Schema.Struct` / `Schema.Literals` / `Schema.optional`.

- [ ] **Step 4: Run tests and typecheck.** Then regenerate the SDK: from repo root run `./packages/sdk/js/script/build.ts`. Confirm `packages/sdk/js/src/v2/gen/sdk.gen.ts` now contains `worktreeCleanup` methods (`grep -n "worktreeCleanup" packages/sdk/js/src/v2/gen/sdk.gen.ts`). Run `bun typecheck` in packages/sdk/js (if it has one) and packages/app.

- [ ] **Step 5: Commit** (stage the new/changed route files, the test, and the regenerated SDK files reported by `git status` under `packages/sdk/` only):

```bash
git add packages/flynncode/src/server/routes/instance/httpapi/groups/worktree-cleanup.ts packages/flynncode/src/server/routes/instance/httpapi/handlers/worktree-cleanup.ts packages/flynncode/src/server/routes/instance/httpapi/api.ts packages/flynncode/src/server/routes/instance/httpapi/server.ts packages/flynncode/test/server/worktree-cleanup-httpapi.test.ts packages/sdk/openapi.json packages/sdk/js/src/v2/gen
git commit -m "feat(flynncode): expose worktree cleanup over the API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Deleting a session disposes its task worktree

**Files:**
- Modify: `packages/flynncode/src/server/routes/instance/httpapi/handlers/session.ts` (delete handler ~l.226-229; reuse `disposeArchivedWorktree` logic ~l.84-104)
- Test: add a case to the existing worktree/session tests (e.g. `packages/flynncode/test/worktree/retention-sweep.test.ts` or a new `test/worktree/session-delete-dispose.test.ts`, mirroring its layer setup)

**Interfaces:**
- Consumes: existing `disposeArchivedWorktree(session)` helper in the same file (reads `metadata.disposable === true && typeof metadata.worktree === "string"`, checks bound sessions, calls `worktreeSvc.disposeIfIdle`, `project.removeSandbox`, `worktreeSvc.retire`).

- [ ] **Step 1: Read** `handlers/session.ts` lines 60-260 and `worktree/bound-sessions.ts`, `worktree/session-binding.ts`. The archive path requires every peer session bound to the worktree to be archived. For delete: read the session info BEFORE `session.remove(id)`, remove the session, then dispose the worktree only if it was disposable and every remaining bound session is archived (a deleted session no longer appears among peers). Factor the shared part so both archive and delete call it; keep `disposeArchivedWorktree`'s current behavior for archive unchanged.

- [ ] **Step 2: Failing test:** a session bound to a disposable worktree (use the existing `bindSession`/`createOwnedWorktree` helpers' approach from `retention-sweep.test.ts`) is deleted through the same code path the handler uses → the worktree directory is gone. A second case: a disposable worktree shared with another non-archived session is kept after deleting one of them.

If the handler is hard to drive directly in a test, extract the post-delete disposal into a named function in `handlers/session.ts` (or next to `disposeArchivedWorktree`) and test that function with the real services.

- [ ] **Step 3: Implement**, **Step 4: run** the new test + `bun test test/worktree` + `bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/flynncode/src/server/routes/instance/httpapi/handlers/session.ts <test file>
git commit -m "fix(flynncode): dispose a session's task worktree when it is deleted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Cleanup page in the app

**Files:**
- Create: `packages/app/src/hooks/use-worktree-cleanup.ts`
- Create: `packages/app/src/pages/cleanup.tsx`
- Modify: `packages/app/src/app.tsx` (import + `<Route path="/cleanup" component={CleanupPage} />` in BOTH places the `/usage` route is registered, l.683 and l.693)
- Modify: `packages/app/src/pages/layout/session-sidebar.tsx` (prop `onOpenCleanup: () => void`; a `SidebarRow` right after the Usage row: icon — pick an existing icon name such as `"trash"` if the Icon set has it, else `"folder"`; `label={language.t("cleanup.page.title")}`, `action="sidebar-cleanup"`)
- Modify: `packages/app/src/pages/layout-new-sidebar.tsx` (`onOpenCleanup={() => navigate("/cleanup")}`)
- Modify: `packages/app/src/i18n/en.ts` and `packages/app/src/i18n/flynncode-fallback.ts` (add every new key to both; `i18n/parity.test.ts` requires it)
- Test: `packages/app/test-browser/cleanup-page.test.ts`

**Interfaces:**
- Consumes: `serverSDK().client.worktreeCleanup.report()`, `.scan()`, `.remove({ paths })` from Task 4 (check the exact generated method names/argument shape in `packages/sdk/js/src/v2/gen/sdk.gen.ts`).

- [ ] **Step 1:** Read `packages/app/src/pages/usage.tsx` and `packages/app/src/hooks/use-provider-usage.ts` and follow them. The hook: `createQuery` with `queryKey: [serverSDK().scope, null, "worktree-cleanup"]`, `queryFn` calling `report()`, `refetchInterval: 60_000`; plus `scan()` and `remove(paths)` functions that call the SDK and then `invalidateQueries` for that key. Export a pure helper `groupByProject(items)` (returns `{ project, items, bytes }[]` sorted by bytes desc) and `formatBytes(bytes, capped)` (`"≥ 41.2 GB"` when capped) from the hook file so the browser test can exercise them.

- [ ] **Step 2: Failing browser test** `packages/app/test-browser/cleanup-page.test.ts` (style: `packages/app/test-browser/sidebar-sections.test.ts`): `groupByProject` groups and sorts; `formatBytes(44_000_000_000, true)` starts with `"≥"`; and a selection helper exported from the page module (e.g. `selectionWarnings(items, selected)` returning the counts of dirty files and unpushed commits that will be lost) returns the right numbers. Run with `cd packages/app && bun test --conditions=browser --preload ./happydom.ts ./test-browser/cleanup-page.test.ts` → FAIL.

- [ ] **Step 3: Implement** the page (same structure and v2 components as `usage.tsx`):
  - Header: `h1` title, total reclaimable size, "Scan now" button (disabled while `scanning`), last-scan time.
  - Groups by project; each item row: checkbox, folder name (full path in a tooltip), branch, size, age (relative time — reuse an existing helper from `packages/app/src/pages/layout/helpers.ts` or the utils if one exists), reason badge (dirty / unpushed / scratch / recent / error) with its `detail`.
  - "Remove selected" opens a confirm dialog (use `useDialog().show` + `Dialog` like `session-sidebar.tsx`'s delete confirmation) listing what will be lost (from `selectionWarnings`); confirming calls `remove(paths)` and shows a toast (`showToast`) with failures if any.
  - Collapsed "Cleaned automatically" section listing `cleaned` (path, size, time).
  - Empty state when there are no items.
  - i18n keys (add to en.ts and flynncode-fallback.ts): `cleanup.page.title` "Cleanup", `cleanup.scan` "Scan now", `cleanup.lastScan` "Last scan {{time}}", `cleanup.reclaimable` "{{size}} reclaimable", `cleanup.removeSelected` "Remove selected", `cleanup.confirm.title` "Remove {{count}} items?", `cleanup.confirm.dirty` "{{count}} uncommitted files will be lost", `cleanup.confirm.unpushed` "{{count}} unpushed commits will be lost (branches are kept)", `cleanup.reason.dirty` "Uncommitted changes", `cleanup.reason.unpushed` "Unpushed commits", `cleanup.reason.scratch` "Scratch folder", `cleanup.reason.recent` "Recently used", `cleanup.reason.error` "Error", `cleanup.cleaned.title` "Cleaned automatically", `cleanup.empty` "Nothing to clean up". Match the interpolation syntax used by existing keys in en.ts.
  - Sidebar row + route wiring as listed in Files.

- [ ] **Step 4: Run** the browser test, the unit suite for touched areas (`cd packages/app && bun test --isolate --conditions=solid --preload ./happydom.ts src/i18n src/pages/layout`), and `bun typecheck` in packages/app.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/hooks/use-worktree-cleanup.ts packages/app/src/pages/cleanup.tsx packages/app/src/app.tsx packages/app/src/pages/layout/session-sidebar.tsx packages/app/src/pages/layout-new-sidebar.tsx packages/app/src/i18n/en.ts packages/app/src/i18n/flynncode-fallback.ts packages/app/test-browser/cleanup-page.test.ts
git commit -m "feat(app): add a Cleanup page for stale worktrees

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Spec sync and verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-25-worktree-cleanup-design.md` (only where the implementation differs; note that busy is covered by 3-day session/message/part recency and the cleaned history is in memory)

- [ ] **Step 1:** Update the spec.
- [ ] **Step 2:** Run and report every result:

```bash
cd packages/flynncode && bun test test/worktree test/server/worktree-cleanup-httpapi.test.ts test/server/httpapi-cors.test.ts test/storage && bun typecheck
cd ../core && bun typecheck
cd ../app && bun test --conditions=browser --preload ./happydom.ts ./test-browser && bun test --isolate --conditions=solid --preload ./happydom.ts src/i18n src/pages/layout && bun typecheck
```

Classify any failure as pre-existing or new (compare against the base commit by reading the failing test and code; do not use `git stash` in this shared checkout).

- [ ] **Step 3: Commit** the spec only.

```bash
git add docs/superpowers/specs/2026-10-25-worktree-cleanup-design.md
git commit -m "docs: sync worktree cleanup spec with the implementation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
