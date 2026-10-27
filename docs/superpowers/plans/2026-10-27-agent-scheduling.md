# Agent Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Flynncode agent schedule prompts back into its own session, matching Claude Code's CronCreate, CronList, CronDelete, ScheduleWakeup and `/loop`. Schedules survive restarts.

**Architecture:**
- A new `session_schedule` table (core) stores the jobs.
- A store module (`packages/flynncode/src/schedule/store.ts`) owns CRUD, next-run calculation and lease claims.
- A scheduler service (`packages/flynncode/src/schedule/scheduler.ts`) ticks every 15 s. It claims due jobs and delivers them as queued synthetic prompts into their sessions.
- Four tools and a built-in `/loop` command are the agent-facing surface.
- Routes, an event and an app side-panel section show and cancel jobs.

**Tech Stack:** TypeScript, Effect 4 beta, Drizzle/SQLite, bun test, SolidJS app, `croner` for cron parsing.

**Spec:** `docs/superpowers/specs/2026-10-27-agent-scheduling-design.md`

## Global Constraints

**Tools** (exact names):
- `cron_create { cron: string, prompt: string, recurring?: boolean }`
  - `recurring` defaults to true.
  - Standard 5-field cron in the server's local time zone.
  - Returns the id and the next run.
  - Recurring jobs expire 7 days after creation.
- `cron_list {}`
- `cron_delete { id }`. An unknown id returns "no such job".
- `schedule_wakeup { delaySeconds, prompt, reason }`
  - `delaySeconds` is clamped to [60, 3600].
  - At most one pending wakeup per session; a new call replaces it.

**Limits:**
- 20 active jobs per session; a wakeup counts.
- Root sessions only. Sessions with a parent get a clear error.

**Permissions:** permission key `schedule`, allowed by default. Scheduled turns ask for tool permissions as usual.

**Table `session_schedule`** (snake_case):
- Columns: `id`, `session_id`, `kind` (`cron`|`wakeup`), `cron`, `prompt`, `reason`, `recurring`, `next_run_at`, `expires_at`, `lease_until`, `failures`, `pending_message_id`, `time_created`.
- It is local only and never synced to the hub. Check the machine-sync/hub sync code (`packages/flynncode/src/machine-sync`, `packages/flynncode/src/sync`) to confirm that new tables aren't picked up automatically.

**Firing:**
- Tick every 15 s.
- Claim atomically: `next_run_at <= now` and (`lease_until` is null or `< now`); set `lease_until = now + 60s`. Deliver only rows whose claim succeeded.
- Deliver as a synthetic text prompt with `queue` delivery. Use the session's current agent/model. `UserPromptSubmit` hooks don't run, because the prompt is synthetic.
- Overlap: if `pending_message_id`'s message is not yet promoted, skip this firing and advance.
- After a successful delivery:
  - recurring: `next_run_at` = next match after now;
  - one-shot/wakeup: delete;
  - clear the lease and `failures`.
- Missed runs fire once.
- Failure: log, `failures + 1`, clear the lease. At 3 consecutive failures, delete and log.
- Expired recurring jobs are deleted on tick.
- A job whose session no longer exists is deleted.

**Transcript divider:**
- "⏰ Scheduled · `<cron>`" or "⏰ Wakeup · `<reason>`".
- The data comes from synthetic part metadata `schedule: { id, kind, cron?, reason? }`.

**`/loop`** is a built-in command; config/Claude `loop` commands override it.
- `/loop <interval> <prompt>`: run now, then `cron_create`.
  - Intervals `Nm`/`Nh`/`Nd`; seconds round up to 1m.
  - An interval that doesn't divide evenly rounds to the nearest supported cron, and the agent is told so.
- `/loop <prompt>`: do the work now. If more remains, call `schedule_wakeup` with a delay chosen from how fast things change. When done, schedule nothing.
- `/loop stop`: delete this session's jobs via `cron_list`/`cron_delete`.

**Lifetime:** a session's jobs are deleted on session delete or archive, including retention cleanup.

**App:**
- Session header chip "⏰ N scheduled", opening a "Scheduled" section in the session side panel (shared with tasks and background shells). Each row shows kind, cron or wakeup time + reason, prompt, next run, and **Cancel**.
- Routes: `GET /session/{id}/schedules` and `DELETE /session/{id}/schedules/{jobId}`.
- Event: `session.schedule.updated { sessionID }` on create/fire/delete/expiry.
- SDK: `client.session.schedules.list` and `.delete` (v2).

**Clock:** injectable for tests. No real-time sleeps longer than needed.

**Repo style (AGENTS.md):**
- No `any`, no import aliases or star imports, `const` over `let`, no `else`.
- Bind Effect services to variables. Comments only for non-obvious constraints. Self-export pattern.
- Drizzle snake_case fields without string names.
- Tests run from package dirs and avoid mocks: use the real DB and the test LLM server `packages/flynncode/test/lib/llm-server.ts`.
- Run `bun typecheck` from package dirs.
- Never write your own files under `/tmp` (TMPDIR=$HOME/.cache/flynncode-test-tmp; delete after). Leave no processes running.

**Shared checkout:**
- Stage explicit paths only; never `git add -A`, `git stash`, `git checkout` or `git worktree prune`.
- DO NOT edit `packages/flynncode/src/tool/{code-mode,computer-use,memory,message,session-manage,task}.ts`. If you would need to, STOP and report BLOCKED.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Table, migration and store

**Files:**
- Add the table to `packages/core/src/session/sql.ts`, or a new `packages/core/src/session/schedule.sql.ts` (matched by `drizzle.config.ts`).
- Generate the migration with `cd packages/core && bun run migration`. Follow commit `fc878b2f3c` (session tombstones) for the exact set of generated files to stage: `migration/*.ts`, `migration.gen.ts`, `schema.gen.ts`, `schema.json`.
- Add the `croner` dependency to `packages/flynncode/package.json` (`bun add croner` in that package; stage `bun.lock`).
- Create `packages/flynncode/src/schedule/store.ts` and `packages/flynncode/test/schedule/store.test.ts`.

**Interfaces (produced):**
- `ScheduleStore.Job` = the row type, with `kind: "cron" | "wakeup"`.
- `ScheduleStore.nextRun(cron: string, after: Date): Date | undefined`. It throws, or returns undefined, on an invalid cron; validate with croner.
- An Effect service `ScheduleStore.Service` with:
  - `create(input: { sessionID; kind; cron?; prompt; reason?; recurring; now: Date }): Effect<Job, ScheduleStore.LimitError | ScheduleStore.InvalidCronError>`. It enforces the 20-job limit. Wakeup replaces the existing wakeup.
  - `list(sessionID): Effect<Job[]>`
  - `remove(sessionID, id): Effect<boolean>`
  - `removeSession(sessionID): Effect<void>`
  - `claimDue(now: Date): Effect<Job[]>`
  - `complete(job, input: { now: Date; messageID: string }): Effect<void>`
  - `skip(job, now: Date): Effect<void>`
  - `fail(job): Effect<void>`
  - `expire(now: Date): Effect<number>`

- [ ] Failing tests (real DB via the existing core/flynncode DB test helpers):
  - create, list and remove;
  - the limit;
  - wakeup replace;
  - invalid cron;
  - `nextRun` for `*/5 * * * *` and `0 9 * * 1`;
  - `claimDue` claims once, and a second claim within the lease returns nothing;
  - complete advances recurring and deletes one-shot;
  - fail ×3 deletes;
  - expire deletes past `expires_at`.
- [ ] Implement.
- [ ] Run `cd packages/core && bun typecheck`, then `cd packages/flynncode && bun test test/schedule && bun typecheck`.
- [ ] Commit `feat(flynncode): store scheduled session prompts`.

### Task 2: Scheduler service

**Files:**
- Create `packages/flynncode/src/schedule/scheduler.ts` and `packages/flynncode/test/schedule/scheduler.test.ts`.
- Register it with server startup next to other process-global services, so it starts and stops with the server.
- Wire session delete/archive to `removeSession`. Find the session delete and archive paths (`packages/flynncode/src/session/session.ts`, `server/**/handlers/session.ts`) and retention cleanup.
- Publish `session.schedule.updated` (v1 bus/event pattern used by e.g. `shell.background.*` events).

**Delivery:** server-level admission of a synthetic `queue` prompt for a session. Use the same admission API that background-shell notifications reach, `TaskPromptOps`/`SessionPrompt.prompt` with `delivery: "queue"`, synthetic text part metadata `schedule: {...}`. The scheduler has no tool context, so find the service-level entry point (SessionPrompt / SessionV2 prompt) and use it directly. Ensure the existing synthetic-prompt rule skips `UserPromptSubmit` hooks.

**Interfaces (produced):**
- `Scheduler.Service` with `tick(now?: Date): Effect<void>`, exposed for tests.
- `Scheduler.layer` takes an injectable clock.

- [ ] Failing tests (real DB + test LLM server):
  - a due job fires into an idle session (one model request whose last user text is the prompt; the part has `schedule` metadata);
  - a busy session gets it after the turn;
  - overlap skip;
  - a missed recurring job fires once and advances;
  - a missed one-shot fires once and is deleted;
  - two scheduler instances on one DB deliver once;
  - session delete/archive removes jobs;
  - a missing session deletes the job;
  - `UserPromptSubmit` hook not run;
  - the event is published.
- [ ] Implement.
- [ ] Run `bun test test/schedule test/session` and `bun typecheck`.
- [ ] Commit `feat(flynncode): deliver scheduled prompts into sessions`.

### Task 3: Tools and `/loop`

**Files:**
- Create the tools as `.ts` + `.txt` descriptions:
  - `packages/flynncode/src/tool/cron-create.ts`
  - `packages/flynncode/src/tool/cron-list.ts`
  - `packages/flynncode/src/tool/cron-delete.ts`
  - `packages/flynncode/src/tool/schedule-wakeup.ts`
- Register them in `packages/flynncode/src/tool/registry.ts`.
- Add the `schedule` permission key, default allow, wherever built-in permission keys and defaults live (see `packages/flynncode/src/config/claude.ts` `BUILTIN_PERMISSIONS` and the agent permission defaults).
- Root-only: look up the session's parent through the Session service, as the background-shell tool does.
- `/loop`: a built-in command beneath config and Claude commands. Find where built-in commands are defined (`packages/flynncode/src/command`). Parse the interval in a small exported helper with tests.
- Tests: `packages/flynncode/test/tool/schedule-tools.test.ts` and `packages/flynncode/test/command/loop.test.ts`.

- [ ] Failing tests:
  - each tool's happy path and errors (invalid cron, limit, unknown id, sub-agent refused);
  - wakeup clamping and replace;
  - `/loop 5m x` → instructions containing `*/5 * * * *`;
  - `/loop 90m x` → rounds to `0 */2 * * *` or the documented nearest, with a note;
  - `/loop x` → wakeup instructions;
  - `/loop stop`;
  - a config `loop` command overrides it;
  - a `deny` on `schedule` blocks the tools.
- [ ] Implement.
- [ ] Run `bun test test/tool test/command test/schedule` and `bun typecheck`.
- [ ] Commit `feat(flynncode): let the agent schedule prompts and loops`.

### Task 4: Routes, SDK and app

**Files:**
- Routes `GET /session/{id}/schedules` and `DELETE /session/{id}/schedules/{jobId}`, following the background-shell routes added for `/session/{id}/shells`.
- Regenerate with `cd packages/client && bun run generate`, plus the legacy SDK if needed.
- App:
  - a session header chip and a "Scheduled" side-panel section, following the background-shells chip/panel (find `background-shells` in `packages/app/src`);
  - list once on open, then re-list on `session.schedule.updated`;
  - Cancel → DELETE.
- Divider: render "⏰ Scheduled · `<cron>`" / "⏰ Wakeup · `<reason>`" for synthetic parts with `schedule` metadata, extending the existing "Background activity" divider logic (see `hook-divider.ts` from the hooks work).
- i18n keys in `packages/app/src/i18n/en.ts` + `flynncode-fallback.ts` (+ `packages/ui/src/i18n/*` if needed).
- Browser tests for the pure helpers: the chip label, the panel rows, the divider text and the cancel request.

- [ ] Failing browser and route tests → implement.
- [ ] Run the app browser suite, i18n tests, the route tests, and `bun typecheck` in app, ui, session-ui, flynncode and client.
- [ ] Prettier on touched files only.
- [ ] Commit `feat(app): show and cancel scheduled prompts`.

### Task 5: Spec sync and verification

- [ ] Update the spec where the implementation differs.
- [ ] Run `cd packages/flynncode && bun test test/schedule test/tool test/command test/session && bun typecheck`, then `cd packages/core && bun typecheck`, then the app browser suite + typecheck.
- [ ] Classify failures without `git stash`. Known pre-existing: `test/session/instruction.test.ts`.
- [ ] Commit `docs: sync agent scheduling spec with the implementation`.
