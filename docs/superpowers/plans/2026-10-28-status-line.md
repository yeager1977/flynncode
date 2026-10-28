# Scriptable Status Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code-compatible `statusLine` command whose output Flynncode shows in the desktop app (a bar under the prompt) and in the TUI session footer.

**Architecture:** A server-side service (`packages/flynncode/src/statusline/`) resolves the command from native config, or falls back to Claude settings behind trust. It watches session changes, runs the command throttled per session with Claude's status JSON on stdin, and publishes `session.statusline`. A route returns the last result. The app and the TUI render the lines.

**Tech Stack:** TypeScript, Effect 4 beta, bun test, SolidJS app, the TUI package (opentui/Solid).

**Spec:** `docs/superpowers/specs/2026-10-28-status-line-design.md`

## Global Constraints

**Config:**
- The setting is `statusLine: { type: "command", command, padding? }`.
- Fallback: Claude `~/.claude/settings*.json`, then project `.claude/settings*.json` `statusLine`.
  - Claude-sourced commands are gated by `HooksTrust`.
  - `OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_CLAUDE_HOOKS` disable the fallback.

**Input JSON:**
- `hook_event_name: "Status"`, `session_id`, `transcript_path` (via `ClaudeTranscript.sync`), `cwd`, `version`
- `model { id, display_name }`
- `workspace { current_dir, project_dir }`
- `output_style { name: agent }`
- `cost { total_cost_usd, total_duration_ms, total_api_duration_ms, total_lines_added, total_lines_removed }`
- `exceeds_200k_tokens`
- `context { used_tokens, limit }`
- The command runs in the session cwd, with `CLAUDE_PROJECT_DIR` set.

**Runs:**
- Triggers: a change to the session's messages, model, agent, folder or status.
- At most one run per 300 ms per session.
- If a run is still in flight, the next due run is skipped.
- A 5 s timeout kills the run.
- A client opening a session with a stale or missing result triggers a run.
- With no config, nothing runs and nothing subscribes.

**Output:**
- Keep the first 2 non-empty stdout lines, each at most 200 chars.
- ANSI SGR is allowed.
- `padding` adds horizontal spacing.

**Delivery:**
- Event `session.statusline { sessionID, lines }`.
- Route `GET /session/{id}/statusline` returns `{ lines, updatedAt }` and triggers a run when stale.
- SDK `client.session.statusline.get`.

**Errors:**
- On a failure, a timeout or empty output, keep the last good lines for at most 60 s, then clear them.
- Log once per session per distinct error.
- An untrusted command is skipped.
- A failure never affects the session or the server.

**Display:**
- App:
  - A thin monospace bar under the prompt box, shown only when there are lines.
  - SGR 16/256 colours, bold and dim become spans; other escapes are stripped.
  - Driven by events, never polling.
- TUI: the session footer shows the lines instead of its fixed content while any exist.

**Repo style (AGENTS.md):**
- No `any`, no import aliases or star imports, `const` over `let`, no `else`.
- Bind Effect services to variables. Comments only for non-obvious constraints.
- Tests run from package dirs and avoid mocks: real scripts, a real server and an injectable clock.
- Run `bun typecheck` from package dirs.
- Never write your own files under `/tmp`: use TMPDIR=$HOME/.cache/flynncode-test-tmp, and don't delete dirs you didn't create.
- Leave no processes running.

**Shared checkout:**
- Stage explicit paths only.
- Never `git add -A`, `git stash`, `git checkout` or `git worktree prune`.
- DO NOT edit `packages/flynncode/src/tool/{code-mode,computer-use,memory,message,session-manage,task}.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Config, runner service, event and route

**Files:**
- Config schema:
  - core config `statusLine` (`packages/core/src/v1/config/config.ts`);
  - Claude settings fallback in the compat pack (`packages/flynncode/src/config/claude.ts`), reusing the settings readers from the hooks work.
- Create `packages/flynncode/src/statusline/{service,input}.ts`.
  - Build the input from the session, its messages, the provider/model catalog, `ClaudeTranscript.sync`, and the cost and line totals the app already shows in session summaries.
  - Run the command with Bun spawn and a kill on timeout.
  - Throttle per session, with an injectable clock.
- Subscribe to the session/message events that matter, only when configured.
- Event `session.statusline` in the v1 event stream and the manifest.
- Route `GET /session/{id}/statusline`, following the `/session/{id}/schedules` route.
- Regenerate the client and legacy SDK; stage only the related generated files.
- Tests: `packages/flynncode/test/statusline/*.test.ts`.

- [ ] Failing tests cover every item in the spec's Testing list 1–7. Implement.
- [ ] Run `bun test test/statusline test/config test/server`. Run `bun typecheck` in flynncode, core and client.
- [ ] Commit `feat(flynncode): run a Claude-compatible status line command`.

### Task 2: App bar and TUI footer

**Files:**
- App: a status bar component under the prompt box, in the session composer area (find where the prompt input sits in `packages/app/src/pages/session` / `components/prompt-input`).
  - On open, fetch with `GET`, then follow `session.statusline` events.
  - Put the ANSI-to-spans conversion in a pure helper with browser tests.
- TUI: in `packages/tui/src/routes/session/footer.tsx`, show the lines instead of the fixed content while any exist. Get the data from the TUI's sync or event layer, following how it gets other session events.
  - Add a footer test if a harness exists; otherwise test a pure helper.
- i18n, if any user-facing strings are needed.

- [ ] Write failing tests, then implement.
- [ ] Run the app browser suite and `bun typecheck` (app, ui, tui). Run the tui tests if they exist. Run prettier on touched files only.
- [ ] Commit `feat(app): show the status line in the app and TUI`.

### Task 3: Docs, spec sync and verification

- [ ] Document `statusLine` in the web docs. Find the config docs page in `packages/web/src/content/docs`.
- [ ] Sync the spec with the implementation.
- [ ] Run the suites from Tasks 1–2.
- [ ] Commit `docs: document the status line and sync its spec`.
