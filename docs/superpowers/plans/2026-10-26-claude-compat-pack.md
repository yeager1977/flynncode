# Claude Compatibility Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Claude Code setup work in Flynncode unchanged (`.claude/agents`, `.claude/commands`) and match Claude Code's plan mode, MultiEdit, NotebookEdit and LSP behavior.

**Architecture:** A Claude adapter converts `.claude` agent/command files into Flynncode's existing config shapes during config loading (before `.opencode` merges, so native definitions win). Model aliases are kept as a marker and resolved at task-spawn time against connected Anthropic models. Command execution gains a permission-checked `` !`cmd` `` and a per-turn `allowed-tools` ruleset. New tools `multiedit`, `notebook_edit`, `enter_plan_mode`, `exit_plan_mode` follow the existing Tool.define patterns; `exit_plan_mode` builds on the Question service. LSP gains a lazy "tool-only" mode (default when `lsp` is unset) with idle shutdown and a 3-server cap. The app gets a plan-approval card, Shift+Tab mode cycling and client-side agent/approval switching.

**Tech Stack:** TypeScript, Effect 4 beta, bun test, SolidJS app, legacy SDK regen (`./packages/sdk/js/script/build.ts`) only if routes/schemas change.

**Spec:** `docs/superpowers/specs/2026-10-26-claude-compat-pack-design.md`

## Global Constraints

- Sources: `~/.claude/{agents,commands}` (global) and `.claude/{agents,commands}` found walking up from the instance directory to the worktree (project; closer wins), following the skill loader pattern (`packages/flynncode/src/skill/index.ts` ~185-203: `CLAUDE_EXTERNAL_DIR`, `fsys.up({ targets: [".claude"], start, stop })`), gated by the existing `flags.disableClaudeCodeSkills`-style flag family (add `OPENCODE_DISABLE_CLAUDE_CODE_AGENTS`/`_COMMANDS` or reuse `OPENCODE_DISABLE_CLAUDE_CODE`). Merged BEFORE `.opencode` sources in `packages/flynncode/src/config/config.ts` (~608-645) so native definitions win; log one warning per name clash.
- Tool-name map: Read→read, Write→write, Edit→edit, MultiEdit→multiedit, Bash→bash, Glob→glob, Grep→grep, WebFetch→webfetch, WebSearch→websearch, TodoWrite→todowrite, Task→task, NotebookEdit→notebook_edit, AskUserQuestion→question; `mcp__*` pass through; unknown → warning, skipped. No `tools` field → all tools.
- Model aliases: `opus|sonnet|haiku` → newest connected Anthropic model of that family (providers `anthropic`, `anthropic-api`, `opencode`, `vercel`; sort `release_date` desc then id desc, like `getSmallModel` in `packages/flynncode/src/provider/provider.ts` ~2135-2160); `inherit` or unresolvable → session model + one-line note in the task result; `provider/model` ids as-is.
- Malformed `.claude` files are skipped with a warning naming the file; never fail config loading.
- Plan file: `Session.plan()` (`packages/flynncode/src/session/session.ts` ~346-351).
- Approval modes: `manual | accept-edits | auto`; app-side per-session state (`packages/app/src/context/permission.tsx` ~315-337).
- LSP lazy mode: when the `lsp` config key is ABSENT, built-in servers are available to the `lsp` tool only (NOT warmed by read/edit/write touchFile), started on first `lsp` call for a file type, stopped after 10 min idle, max 3 running; `lsp: true`/object keeps today's behavior plus the idle stop and cap; `lsp: false` turns everything off.
- Repo style (AGENTS.md): no `any`, no import aliases or star imports, `const` over `let`, no `else`, bind Effect services to variables, comments only for non-obvious constraints, self-export pattern. Tests from package dirs; `bun typecheck` from package dirs. Never write your own files under `/tmp` (if needed `TMPDIR=$HOME/.cache/flynncode-test-tmp`, deleted afterwards). Leave no processes running.
- Shared checkout: stage explicit paths only; never `git add -A`; never `git stash`. DO NOT edit `packages/flynncode/src/tool/{code-mode,computer-use,memory,message,session-manage,task}.ts` (another agent's uncommitted changes) — if a task needs one of them, STOP and report BLOCKED. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: `.claude/agents` loader and model aliases

**Files:** Create `packages/flynncode/src/config/claude.ts` (adapter: parse Claude agent markdown → Flynncode agent config: name, description, prompt=body, `mode: "subagent"`, tools string → permission rules (deny tools not listed when `tools` is present), color name → nearest theme literal or omitted, model: keep `provider/model` ids, store aliases as `options.claudeModel: "opus"|"sonnet"|"haiku"|"inherit"` and leave `model` unset); modify `packages/flynncode/src/config/config.ts` (load before `.opencode`, native wins, warn on clash); create `packages/flynncode/src/provider/claude-alias.ts` (resolve alias → `{ providerID, modelID } | undefined` from connected providers); test files under `packages/flynncode/test/config/` and `test/provider/`.

Note: the task tool (`tool/task.ts`) is off-limits. Resolve the alias where the agent's model is read when spawning (find where `agent.model` is used for a subagent run — e.g. session prompt/LLM model selection — and apply `options.claudeModel` there); if the only reasonable place is `task.ts`, STOP and report BLOCKED with the exact location.

- [ ] Failing tests: user + project files load (project overrides user); tools mapping incl. unknown + `mcp__x__y`; no `tools` → all tools; color names don't fail parsing; malformed file skipped with warning; native `.opencode` agent with the same name wins; alias resolution picks the newest connected Anthropic model of the family; `inherit`/unavailable → undefined (session model used).
- [ ] Implement; `bun test` the new files + `test/config` + `test/agent` (if present); `bun typecheck`.
- [ ] Commit `feat(flynncode): load Claude Code agents from .claude/agents`

### Task 2: `.claude/commands` loader

**Files:** extend `packages/flynncode/src/config/claude.ts` (commands: body → template, `description`, `argument-hint` (new optional field on command info), `model` alias (same marker approach), `allowed-tools` (stored as a string list on the command), `disable-model-invocation` (stored)); namespacing `sub/dir/x.md` → `sub:dir:x`; modify config loading the same way as agents; extend `core/src/v1/config/command.ts` schema with optional `argumentHint`, `allowedTools: string[]`, `disableModelInvocation: boolean`, `claudeModel` (or reuse options) — keep backward compatible; the command picker/`hints()` shows `argument-hint` when present (packages/flynncode/src/command/index.ts).

- [ ] Failing tests: namespacing; frontmatter fields carried; project overrides user; native wins; malformed skipped.
- [ ] Implement; tests + typecheck (flynncode, core). If the public schema changes affect the SDK, regenerate it (`./packages/sdk/js/script/build.ts`) and stage only related generated changes.
- [ ] Commit `feat(flynncode): load Claude Code slash commands from .claude/commands`

### Task 3: Command execution — permission-checked `!` and per-turn `allowed-tools`

**Files:** `packages/flynncode/src/session/prompt.ts` (`SessionPrompt.command` ~1586-1700 where `ConfigMarkdown.shell` runs `` !`cmd` `` without a permission check ~1627-1637), `packages/flynncode/src/session/tools.ts` (where `Permission.merge(agent.permission, session.permission)` builds the ruleset), message/user-input types as needed; tests in `test/session/`.

- `` !`cmd` ``: before running, ask the `bash` permission exactly as the bash tool does (same patterns/`always` derivation — reuse the shell tool's pattern collection helper if exported; otherwise export a minimal helper from `tool/shell.ts` without changing its behavior). Denied → the command is aborted with an error message naming the denied command; nothing is sent to the model.
- `allowed-tools` (Claude syntax: `Read`, `Bash(git add:*)`, `Bash(npm test)`, `mcp__x__y`): convert to allow rules (tool name map from the constraints; `Bash(prefix:*)` → bash pattern `prefix *`; `Bash(exact)` → exact pattern) and attach them to the command's user message as a per-message ruleset merged for that turn only (NOT persisted via `sessions.setPermission`). The next user message has no extra rules.
- Model alias on commands: resolve like agents (Task 1 helper).
- [ ] Failing tests: `!` allowed → output inlined; `!` denied → command aborted, no model call; allowed-tools grants `Bash(git status:*)` for that turn and not the next; alias resolution.
- [ ] Implement; `bun test test/session` (relevant files) + typecheck.
- [ ] Commit `feat(flynncode): ask before command shell expansion and honor allowed-tools per turn`

### Task 4: `multiedit` tool

**Files:** create `packages/flynncode/src/tool/multiedit.ts` + `.txt`; register in `tool/registry.ts` next to `edit` and include it in the GPT `apply_patch` swap (`registry.ts` ~333-337: hidden when `usePatch`); test `packages/flynncode/test/tool/multiedit.test.ts`.

- Same permission (`edit`, patterns `[relPath]`, metadata with the combined diff), per-path lock, format, events, filediff, LSP diagnostics as `edit.ts` (reuse its helpers; extract a shared helper from edit.ts only if needed, without changing edit's behavior). Apply edits in order in memory; any failure (not found / ambiguous without `replace_all` / `old_string === new_string`) → no write, error names the edit index.
- [ ] Failing tests: multiple edits applied atomically; failing 2nd edit → file unchanged; ambiguity error; permission denied → no write; hidden for gpt models.
- [ ] Implement; `bun test test/tool` (relevant) + typecheck; update parameters snapshot if the test suite snapshots tool params.
- [ ] Commit `feat(flynncode): add a multiedit tool`

### Task 5: `notebook_edit` tool and notebook reading

**Files:** create `packages/flynncode/src/tool/notebook-edit.ts` + `.txt`; modify `tool/read.ts` so `.ipynb` renders as cells with `cell_id`, type and source (outputs summarized), keeping line-number style; register `notebook_edit`; tests.

- Edit modes: `replace` (cell_id required), `insert` (after `cell_id`, or at start when absent; `cell_type` required), `delete`. Preserve the notebook's JSON indentation and key order; clear `outputs` and `execution_count` on edited code cells; generate ids for new cells (nbformat ≥4.5 `id`); notebooks without ids → address cells by `cell-N` index and say so in read output. Validate JSON; unknown cell id → error, no write. Permission `edit`.
- [ ] Failing tests: replace/insert/delete; other cells' outputs preserved; formatting preserved; unknown id error; read shows ids.
- [ ] Implement; tests + typecheck.
- [ ] Commit `feat(flynncode): add notebook_edit and show notebook cells in read`

### Task 6: LSP on by default (lazy tool-only mode)

**Files:** `packages/flynncode/src/lsp/lsp.ts` (~146-290), `packages/flynncode/src/tool/registry.ts` (~285, drop the experimental gate), `core/src/v1/config/config.ts` (~199-202 description), tests under `test/lsp/`.

- `lsp` key absent → lazy mode: built-in servers registered but `touchFile` from read/edit/write does NOT spawn them; only the `lsp` tool's operations do. `lsp: true`/object → current behavior. `lsp: false` → off (tool returns "LSP is disabled in config").
- In all enabled modes: idle stop after 10 min without requests (injectable clock/timer for tests), max 3 running clients per process (starting a 4th stops the least recently used), clients are tracked children shut down on instance dispose (existing) — verify no orphan on server exit.
- Missing server binary / unsupported extension → tool result "no language server for .<ext>" (no throw).
- [ ] Failing tests: lazy mode doesn't spawn on read; spawns on lsp call (use a tiny fake LSP server script — e.g. a node/bun script speaking minimal JSON-RPC — committed under test fixtures, not a real language server); idle stop; LRU cap; missing server message; `lsp:false` message.
- [ ] Implement; tests + typecheck.
- [ ] Commit `feat(flynncode): enable the LSP tool with lazily started language servers`

### Task 7: Plan mode — server

**Files:** `packages/flynncode/src/tool/plan.ts` (add `EnterPlanModeTool` `enter_plan_mode`; turn `plan_exit` into `exit_plan_mode` (keep `plan_exit` as an alias id only if needed for existing sessions/permissions), using `Question.ask` with options exactly: "Approve — auto-accept edits", "Approve — ask for each edit", "Keep planning" and `custom: true` for feedback); `tool/registry.ts` (register both for all clients, no experimental flag; enter only for primary non-plan agents; refuse in sub-agent sessions); `agent/agent.ts` (permissions: `enter_plan_mode` allowed for build, `exit_plan_mode` for plan); `session/reminders.ts` (use the plan-mode reminder path without the flag); tests in `test/tool/plan.test.ts`.

- enter: inserts a synthetic user message with `agent: "plan"` (same mechanism `plan_exit` uses for build) and returns "Switched to plan mode"; metadata `{ mode: "plan", reason }`.
- exit: writes the plan markdown to `Session.plan()`; asks; on approve inserts the synthetic build message (existing pattern) and returns metadata `{ approved: true, approval: "accept-edits" | "manual" }`; on "Keep planning" returns the feedback text to the agent (stays in plan); custom free-text answer = keep planning with that feedback; dismiss → keep planning.
- [ ] Failing tests: enter switches the next loop agent to plan; refused in a child session; exit writes the plan file; each outcome's metadata/agent; feedback returned.
- [ ] Implement; `bun test test/tool` (plan + registry) + typecheck.
- [ ] Commit `feat(flynncode): add Claude-style enter and exit plan mode tools`

### Task 8: Plan mode — app

**Files:** `packages/app/src/pages/session/composer/session-question-dock.tsx` (or a new `plan-approval-dock.tsx` used when the pending question belongs to an `exit_plan_mode` call: render the plan markdown from the tool input, three buttons + feedback box); `packages/app/src/context/local.tsx` and `packages/app/src/context/permission.tsx` (after an approved `exit_plan_mode` completes, set the session's client agent to `build` and its approval mode to the chosen one — unless the current mode is `auto`, which is kept; after `enter_plan_mode` completes, set the client agent to `plan`); `packages/app/src/components/prompt-input.tsx` (+ `prompt-input-v2.tsx`) Shift+Tab cycles build → plan → build regardless of `showCustomAgents`; mode indicator next to the agent control; an Undo link on the `enter_plan_mode` tool card in `packages/session-ui/src/components/message-part.tsx` (sets the client agent back to the previous one); i18n keys in `packages/app/src/i18n/en.ts` + `flynncode-fallback.ts` (and `packages/ui/src/i18n/*` only if strings live there); browser tests `packages/app/test-browser/plan-mode.test.ts` for pure helpers (outcome → agent/approval mapping incl. auto preservation; Shift+Tab cycle).

- Mirror how the TUI reacts to a completed `plan_exit` (`packages/tui/src/routes/session/index.tsx` ~333-339).
- [ ] Failing browser tests → implement → browser suite + `bun test --isolate --conditions=solid --preload ./happydom.ts src/i18n` + typecheck (app, session-ui) → prettier on touched files only (explicit list) → commit `feat(app): plan mode approval card and Shift+Tab mode switching`

### Task 9: Spec sync and verification

- [ ] Update the spec where implementation differs (known: no file watcher — `.claude` files reload with config like `.opencode` ones; `multiedit` mirrors `edit`, which has no read-before-edit rule; LSP lazy mode applies when `lsp` is unset).
- [ ] Run: `cd packages/flynncode && bun test test/config test/tool test/session test/lsp test/provider && bun typecheck`; `cd packages/app && bun test --conditions=browser --preload ./happydom.ts ./test-browser && bun test --isolate --conditions=solid --preload ./happydom.ts src/i18n && bun typecheck`; `cd packages/session-ui && bun typecheck`. Classify failures (pre-existing vs new) without `git stash`.
- [ ] Commit the spec: `docs: sync Claude compatibility pack spec with the implementation`
