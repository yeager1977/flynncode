# Worktree Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Flynncode main agent move its session into a new git worktree mid-session, and back out again, like Claude Code's EnterWorktree and ExitWorktree.

**Architecture:**
- Two tools, `enter_worktree` and `exit_worktree`, live in `packages/flynncode/src/tool/`. They create or dispose worktrees through the existing worktree service and switch the session's primary folder. That folder switch is extracted from the folders route into a reusable helper.
- The prompt loop sees a folder change after a tool step and continues the turn under the new folder's instance.
- The app follows the session to its new folder and renders a divider.

**Tech Stack:** TypeScript, Effect 4 beta, bun test, SolidJS app.

**Spec:** `docs/superpowers/specs/2026-10-27-worktree-tools-design.md`

## Global Constraints

**Tools:**
- `enter_worktree { name?: string }`
  - Refused when the project is not git, the session is a sub-agent, the session is already inside an entered worktree, or a switch already happened this step.
  - Branch: `<branch_prefix>/<name>`, else `<branch_prefix>/session-<slug>`.
  - Session metadata gets `worktree` (existing binding), `enteredFrom`, `disposable: true`. Writes are merge-safe.
  - Returns the path and branch.
- `exit_worktree { action: "keep" | "remove", discard_changes?: boolean }`
  - Only valid when `enteredFrom` is set.
  - Moves back to `enteredFrom` and clears `enteredFrom` and the worktree binding.
  - `remove` uses `disposeIfSafe` and refuses, listing what would be lost, when unsafe.
  - `discard_changes: true` forces removal after asking under `worktree`.
  - `keep` and a safe `remove` don't prompt.

**Permissions:**
- Key `worktree`, default `ask`, for entering and for a forced discard.
- Prompt patterns: the branch and path, or a description of the loss.

**Turn mechanics:**
- After a tool step, if the session's primary folder changed, continue the same turn under the new folder's instance. Reload history.
- Add a one-line synthetic note: "Working directory is now `<path>` (branch `<branch>`)."
- At most one switch per step.
- Extra folders, background shells, schedules and approvals stay with the session.

**Lifetime:** an entered worktree is disposable, so archive or delete disposes it only if safe (existing path).

**Errors:**
- A creation failure returns the message and leaves the session in place.
- A switch failure after creation removes the new worktree.
- If `enteredFrom` is missing, fall back to the project's main folder and say so.

**App:**
- Sidebar regrouping (existing).
- An open session follows to its new directory without a reload.
- Divider: "⎇ Entered worktree `<branch>`" / "⎇ Back in `<folder>` (worktree kept|removed)".

**Claude map:** `EnterWorktree` → `enter_worktree`, `ExitWorktree` → `exit_worktree`, in `TOOLS` in `packages/flynncode/src/config/claude.ts`.

**Repo style (AGENTS.md):**
- No `any`; no import aliases or star imports.
- `const` over `let`; no `else`.
- Bind Effect services to variables.
- Comments only for non-obvious constraints.
- Tests run from package dirs and avoid mocks: use real git repos and the test LLM server `packages/flynncode/test/lib/llm-server.ts`.
- Run `bun typecheck` from package dirs.
- Never write your own files under `/tmp`: use `TMPDIR=$HOME/.cache/flynncode-test-tmp`, and don't delete dirs you didn't create.
- Leave no processes running.

**Shared checkout:**
- Stage explicit paths only.
- Never run `git add -A`, `git stash`, `git checkout` or `git worktree prune` on the real repo; tests use their own temp repos.
- DO NOT edit `packages/flynncode/src/tool/{code-mode,computer-use,memory,message,session-manage,task}.ts`. If you need to, STOP and report BLOCKED.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Folder switch helper, tools and permissions

**Files:**
- Extract the primary-folder switch out of the folders route (`packages/flynncode/src/server/routes/instance/httpapi/handlers/session.ts` `updateFolders`) into a reusable session-level helper. Suggested location: `packages/flynncode/src/session/folder-switch.ts`.
  - It keeps the same-project check, `setDirectory`, project directory creation and instance setup.
  - The route uses the helper, and its behaviour is unchanged.
- Create `packages/flynncode/src/tool/enter-worktree.ts` and `.txt`, and `packages/flynncode/src/tool/exit-worktree.ts` and `.txt`.
- Register both in `registry.ts`.
- Add the `worktree` permission key (default `ask`) wherever built-in keys and defaults live.
- Add the Claude `TOOLS` map entries.
- Tests: `packages/flynncode/test/tool/worktree-tools.test.ts` and the route regression tests.

**Interfaces:**
- Produces `SessionFolderSwitch.switchPrimary(input: { sessionID; directory: string }): Effect<{ previous: string; next: string }, …>`. Name it to match nearby code.
- The tool results carry metadata `worktree: { action: "enter" | "exit", branch?, path, removed? }` for the app.

- [ ] Write failing tests:
  - enter creates the worktree, switches the session directory and sets the metadata (other keys preserved);
  - exit keep and exit remove (safe, unsafe-refused, discard-forced);
  - every refusal case;
  - the permission ask for entering includes the branch and path;
  - the route behaves the same as before.
- [ ] Implement.
- [ ] Run `bun test test/tool test/worktree test/server` (+ the session route tests) and `bun typecheck`.
- [ ] Commit `feat(flynncode): let the agent enter and exit worktrees`.

### Task 2: Turn mechanics

**Files:**
- `packages/flynncode/src/session/prompt.ts` (loop):
  - after each tool step, re-read the session's directory;
  - if it changed, continue the same turn under `InstanceStore.provide(newDirectory)`, following how the scheduler and task tool provide instances;
  - inject the one-line synthetic note;
  - enforce one switch per step.
- Check that snapshots and the session diff, LSP and the file tools use the new instance from the next step on.
- Archive/delete: confirm the existing disposable-worktree disposal path handles `enteredFrom` worktrees (`disposable: true` plus the `worktree` binding), and fix it if not.
- Tests: `packages/flynncode/test/session/worktree-switch.test.ts`, using a real git repo and the test LLM server. Scripted model:
  1. `enter_worktree`;
  2. `bash pwd`, whose output must equal the worktree path;
  3. `exit_worktree keep`;
  4. `bash pwd`, whose output must equal the original folder.
  Also test:
  - the synthetic note appears in the next request;
  - archive disposes only when safe;
  - background shells started before entering keep running.

- [ ] Failing tests → implement → run `bun test test/session test/tool test/worktree` and `bun typecheck`.
- [ ] Commit `feat(flynncode): continue the turn in the session's new folder`.

### Task 3: App

**Files:**
- When an open session's directory changes (a `session.updated` event), the app follows it to the session's new directory route without a reload, and streaming continues. Find how session routes encode the directory (`packages/app/src/pages/session`, `utils/worktree.ts`, `checkout-handoff.ts`) and how sidebar handoff navigation works.
- Divider rendering for `enter_worktree` / `exit_worktree` tool parts, following the scheduled-prompt and hook dividers.
- i18n keys in `packages/app/src/i18n/en.ts` + `flynncode-fallback.ts` (+ `packages/ui/src/i18n/*` if needed).
- Browser tests for the follow helper and the divider text.

- [ ] Failing browser tests → implement.
- [ ] Run the browser suite + i18n tests + `bun typecheck` (app, ui, session-ui).
- [ ] Run prettier on touched files only.
- [ ] Commit `feat(app): follow sessions into worktrees`.

### Task 4: Spec sync and verification

- [ ] Update the spec where the implementation differs.
- [ ] Run:
  - `cd packages/flynncode && bun test test/tool test/session test/worktree test/server && bun typecheck`
  - the app browser suite + typecheck.
- [ ] Known pre-existing failure: `instruction.test.ts`.
- [ ] Commit `docs: sync worktree tools spec with the implementation`.
