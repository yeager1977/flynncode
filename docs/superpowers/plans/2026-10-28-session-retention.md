# Session Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically delete session trees that have been inactive for `cleanupPeriodDays` (default 30), as Claude Code does. Provide a Keep toggle, a settings row, deletion hints and a first-run delay.

**Architecture:**
- A `SessionRetention` service in `packages/flynncode/src/session/retention/` runs an hourly pass in the per-machine leader process.
- Each pass finds inactive, non-kept trees and deletes them through the manual-delete path, so tombstones sync.
- A route provides hint data.
- The app adds the Keep toggle, a pin icon, a "deletes in N days" hint, a settings row and a first-run notice.

**Tech Stack:** TypeScript, Effect 4 beta, Drizzle/SQLite, bun test, SolidJS app.

**Spec:** `docs/superpowers/specs/2026-10-28-session-retention-design.md`

## Global Constraints

**Setting:** `cleanupPeriodDays`
- A top-level key in the Flynncode config.
- An integer; default 30, minimum 1.
- A value of 0 or below fails validation, and retention does not run with an invalid value.

**Deletion unit:** a root session plus all of its descendants. Sub-agents are never deleted alone.

**Inactive:** the maximum update time across the session, message and part rows of the root and every descendant is older than N days.
- A future timestamp counts as active.
- Trees are skipped if they have:
  - `keep: true` in the root's metadata;
  - an active `session_schedule` job;
  - a running background shell.

**Passes:**
- Hourly, with the first pass 5 minutes after launch.
- Only the leader runs passes: use a cross-process lock like `Scheduler.enableLeadership`, with its own lock key. Eligible processes are the sidecar, the TUI worker and serve; never `flynncode run` or tests.
- At most 50 trees per pass.
- Log one line per pass.

**First run:**
- If more than 20 trees are eligible on the first pass ever, wait 24 hours.
- Persist `firstRunAt` and `pendingFirstRunCount` in a JSON file under `Global.Path.state`.
- Show a one-time notice in the app.

**Deletion:** use exactly the manual-delete path: `Session.remove` recursion, tombstones, worktree dispose-if-safe, and schedule/transcript removal.

**Keep:**
- Stored in the root's `metadata.keep`, written merge-safe (read, spread, set).
- In the menu: "Keep forever" / "Stop keeping", on root sessions only. A pin icon shows in the sidebar.

**Hint:** "deletes in N days" when a tree is within 3 days of deletion.

**API:**
- `GET /session/retention` → `{ cleanupPeriodDays, firstRunAt?, pendingFirstRunCount?, expiring: [{ sessionID, deletesAt }] }`
- Event `session.retention.updated`.
- Keep goes through the existing session update/metadata route if it is merge-safe; otherwise add `PATCH /session/{id}/keep`.

**Settings row:** "Delete sessions inactive for more than [N] days". It writes `cleanupPeriodDays` to the global Flynncode config.

**Repo style (AGENTS.md):**
- No `any`, no import aliases or star imports, `const` over `let`, no `else`.
- Bind Effect services to variables. Comments only for non-obvious constraints.
- Tests run from package dirs and avoid mocks: use the real DB and an injectable clock.
- Run `bun typecheck` from package dirs.
- Never write your own files under `/tmp`: use TMPDIR=$HOME/.cache/flynncode-test-tmp, and don't delete dirs you didn't create.
- Leave no processes running.

**Shared checkout:**
- Stage explicit paths only; never `git add -A`, `git stash`, `git checkout` or `git worktree prune`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Never run retention against the owner's real database in tests or manual checks.**

---

### Task 1: Config, retention service, route and event

**Files:**
- Core config `cleanupPeriodDays` (`packages/core/src/v1/config/config.ts`), with validation.
- `packages/flynncode/src/session/retention/{service,query}.ts`:
  - the tree-activity query (efficient SQL over session, message and part update times, grouped by root);
  - the pass;
  - leadership;
  - the first-run state file.
- Wire session deletion through the existing remove path.
- Start and stop with the server, like the scheduler.
- Route `GET /session/retention` and event `session.retention.updated`.
- Regenerate the legacy SDK; stage only related changes.
- Tests: `packages/flynncode/test/session/retention.test.ts` plus a route test.

**Steps:**
- [ ] Write failing tests for spec Testing items 1–8.
- [ ] Implement.
- [ ] Run `bun test test/session test/schedule test/server`. Run `bun typecheck` in flynncode and core.
- [ ] Commit `feat(flynncode): delete inactive session trees after cleanupPeriodDays`.

### Task 2: App

**Files:**
- Session context menu: "Keep forever" / "Stop keeping" on root sessions, plus the "deletes in N days" hint. Find the sidebar session menu (`packages/app/src/pages/layout/sidebar-*`).
- Pin icon next to kept sessions' titles.
- General settings "Session history" row (`packages/app/src/components/settings-v2/`).
- One-time first-run notice. Use the existing notification or toast patterns, and record that it was shown in local app storage.
- Fetch `GET /session/retention` once, then follow `session.retention.updated`.
- i18n keys in `en.ts` + `flynncode-fallback.ts` (and `packages/ui/src/i18n/*` if needed).
- Browser tests for the helpers.

**Steps:**
- [ ] Write failing browser tests.
- [ ] Implement.
- [ ] Run the browser suite, the i18n tests and `bun typecheck` (app, ui).
- [ ] Run prettier on touched files only.
- [ ] Commit `feat(app): keep sessions and set how long history is kept`.

### Task 3: Docs, spec sync, verification

**Steps:**
- [ ] Document `cleanupPeriodDays` and Keep in the web docs (config page).
- [ ] Sync the spec with the implementation.
- [ ] Run the Task 1–2 suites.
- [ ] Commit `docs: document session retention and sync its spec`.
