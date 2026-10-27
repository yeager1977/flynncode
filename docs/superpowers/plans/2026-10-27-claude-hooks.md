# Claude-Compatible Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run hooks written for Claude Code in Flynncode, from three sources: Claude user and project settings, and enabled Claude plugins. They use Claude's input/output format. Add the missing events, decisions and handler types for all hooks.

**Architecture:** Claude hooks are loaded by the compat pack (`packages/flynncode/src/config/claude.ts`) into the existing hook config, as matcher groups tagged `format: "claude"` with a `source` id and `env`. The executor (`packages/flynncode/src/hooks/executor.ts`) builds Claude stdin and parses Claude stdout for those groups through a new translation module (`packages/flynncode/src/hooks/claude-format.ts`), and keeps the native protocol for the rest. A transcript writer (`packages/flynncode/src/hooks/claude-transcript.ts`) keeps a Claude-format JSONL per session for `transcript_path`. New events (`PostToolUseFailure`, `Notification`), the `ask` decision, blocking `Stop`/`SubagentStop`/`UserPromptSubmit`, and `http`/`prompt` handlers go through the existing runner.

**Tech Stack:** TypeScript, Effect 4 beta, bun test, SolidJS app.

**Spec:** `docs/superpowers/specs/2026-10-27-claude-hooks-design.md`

## Global Constraints

**Sources:**
- Claude user: `~/.claude/settings.json` and `~/.claude/settings.local.json`.
- Claude project: `<dir>/.claude/settings.json` and `settings.local.json` for the project `.claude` dirs from `claudeDirs` in `packages/flynncode/src/config/config.ts` (~501).
- Claude plugins: every `enabledPlugins` entry that is `true` in `~/.claude/settings.json`, resolved through `~/.claude/plugins/installed_plugins.json` (version 2: `plugins[name] = Array<{ scope, installPath, ... }>`). Prefer a `user`-scope entry, else the last entry. Hooks come from `<installPath>/hooks/hooks.json`, key `hooks`.

**Source ids:**
- `claude:user`
- `claude:project:<absolute .claude dir>`
- `claude:plugin:<name@marketplace>`

**Merge order:** Claude groups are appended after native groups for each event, so native hooks run first.

**Variables:**
- `${CLAUDE_PLUGIN_ROOT}` (the plugin install path) and `${CLAUDE_PROJECT_DIR}` (the project root) are expanded in command strings, and also set as env vars.
- Plugin hooks also get `CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/<plugin id with @ replaced by ->`.

**Trust:**
- `claude:user` hooks are trusted, like native user hooks.
- `claude:project:*` and `claude:plugin:*` hooks go through the existing `HooksTrust` (`packages/flynncode/src/hooks/trust.ts`). A changed command means a new hash, so the user is asked again.
- The trust prompt names the source.

**Switches:**
- `disableAllHooks` disables everything.
- `OPENCODE_DISABLE_CLAUDE_HOOKS=1` disables only Claude sources. `OPENCODE_DISABLE_CLAUDE_CODE` disables them too.
- Config `claude_hooks.disabled: string[]` lists source ids to skip.

**Not imported:** anything else from Claude settings (permissions, env, model) or plugins (commands, agents, skills, MCP).

**Claude stdin fields:** exactly the spec's table:
- All events: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`.
- Per event: `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `error`, `is_interrupt`, `prompt`, `source`, `reason`, `trigger`, `custom_instructions`, `stop_hook_active`, `agent_id`, `agent_type`, `message`, `notification_type`.

**Translation:**
- Tool names come from the reverse of `TOOLS` in `packages/flynncode/src/config/claude.ts`. MCP tools become `mcp__<server>__<tool>`. Unknown tools pass through under their Flynncode id.
- `tool_input` keys of translated tools go camelCase → snake_case. `updatedInput` goes snake_case → camelCase. Keys that don't map are dropped with a warning.
- Claude-format matchers are tested against the Claude tool name.

**Claude output:**
- Exit 2 by event:
  - `PreToolUse`/`PermissionRequest`: deny, stderr to the model.
  - `PostToolUse`/`PostToolUseFailure`: stderr to the model.
  - `UserPromptSubmit`: block the prompt, stderr to the user.
  - `Stop`/`SubagentStop`: block, stderr is the continuation reason.
  - Others: logged.
- Exit 0 + a JSON object: the JSON decision. Fields:
  - `continue:false` + `stopReason`
  - `systemMessage`
  - `decision:"block"` + `reason`
  - `hookSpecificOutput.{permissionDecision: allow|deny|ask, permissionDecisionReason, updatedInput, additionalContext}`
- Exit 0 + plain text: context on `SessionStart` and `UserPromptSubmit`, ignored elsewhere.
- Any other exit, a timeout or a spawn failure: logged and ignored.
- Native hooks keep their current semantics, including deny-on-error for decision hooks.

**New for all hooks:**
- **`ask`:** native `{behavior:"ask", message?}` or Claude `permissionDecision:"ask"` forces the normal permission prompt even when a rule allows. Precedence: deny > ask > allow > undecided.
- **`PostToolUseFailure`:** fires instead of `PostToolUse` when a tool errors or is aborted. Input: error text, `is_interrupt`.
- **`Notification`:** observe-only. Fires when a permission prompt or question waits (`notification_type`: `permission_prompt` | `question`), and when a root session goes idle after a turn (`idle`).
- **Blocking `Stop` and `SubagentStop`:**
  - They run at the end of the prompt loop, before idle. A child session (one with `parentID`) fires `SubagentStop`; a root session fires `Stop`.
  - A block queues the reason as a synthetic user prompt and continues. The next input has `stop_hook_active: true`.
  - At most 8 forced continuations per user prompt; then the stop is allowed and a warning is logged.
- **Blocking `UserPromptSubmit`:** exit 2, `decision:"block"`, native `{behavior:"deny"}` or prompt `ok:false` means the prompt is not admitted, and the user sees the reason.
- **Native blocking:** exit 2 (stderr is the reason) or `{behavior:"deny", message}` on `Stop`/`SubagentStop`/`UserPromptSubmit`.

**Handlers:**
- **`http`** `{type:"http", url, headers?: Record<string,string>, allowedEnvVars?: string[], timeout?, statusMessage?}`:
  - POSTs the hook input JSON.
  - `$VAR`/`${VAR}` in headers is filled only for `allowedEnvVars` names; others become empty.
  - A 2xx JSON body is read as JSON output in the group's format.
  - A non-2xx status, a timeout, a network error or a non-JSON body is logged and ignored.
- **`prompt`** `{type:"prompt", prompt, model?, timeout?, statusMessage?}`:
  - `$ARGUMENTS` is replaced with the input JSON. If it is absent, the input is appended.
  - Model: `model`, else `small_model`, else the session model. The answer must be `{ok:boolean, reason?}`.
  - `ok:false` blocks: deny on `PreToolUse`, block on `UserPromptSubmit`, continue on `Stop`/`SubagentStop`, logged elsewhere.
  - Errors and invalid JSON are logged and ignored.
- No `agent` type.

**Timeouts** (`timeout` in seconds):
- **Plan clarification:** command hooks keep the existing default (`DEFAULT_COMMAND_TIMEOUT_MS` = 600 s; `SessionEnd` 1 s/3 s max).
- `http` and `prompt` default to 60 s.
- The spec's "60 s for every handler type" is corrected in Task 7.

**Transcript:**
- File: `Global.Path.data/claude-transcripts/<sessionID>.jsonl`. It is brought up to date right before a Claude-format hook runs, and only for sessions where one runs.
- Line format, one JSON object per message:
  - `type` (`user`|`assistant`)
  - `message` (`role`, `content` blocks `text` | `tool_use{id,name,input}` | `tool_result{tool_use_id,content,is_error}`)
  - `uuid`, `parentUuid`, `timestamp` (ISO), `sessionId`, `cwd`
- It is append-only; the last written message id lives in `<sessionID>.cursor`.
- It is deleted with its session and covered by history retention.
- A write failure is logged; the hook still runs with the last good path, or `""`.

**Repo style (AGENTS.md):**
- No `any`, no import aliases or star imports.
- `const` over `let`, no `else`.
- Bind Effect services to variables.
- Comments only for non-obvious constraints.
- The self-export pattern.
- Tests run from package dirs and avoid mocks: use real processes, real local HTTP servers and the test LLM server (`packages/flynncode/test/lib/llm-server.ts`).
- `bun typecheck` from package dirs.
- Never write your own files under `/tmp`: use `TMPDIR=$HOME/.cache/flynncode-test-tmp` and delete after. Leave no processes running.

**Shared checkout:**
- Stage explicit paths only; never `git add -A`, `git stash`, `git checkout` or `git worktree prune`.
- DO NOT edit `packages/flynncode/src/tool/{code-mode,computer-use,memory,message,session-manage,task}.ts`. If you need to, STOP and report BLOCKED.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Schema, Claude hook loading, trust and switches

**Files:**
- `packages/core/src/v1/config/hooks.ts`:
  - `HookGroup` gains optional internal `source?: string`, `format?: "native" | "claude"` and `env?: Record<string,string>`.
  - `HookHandler` gains the `http` and `prompt` variants exactly as in Global Constraints; execution comes in Task 6.
  - `Info` gains `PostToolUseFailure` and `Notification`.
- `packages/core/src/v1/config/config.ts`: `claude_hooks?: { disabled?: string[] }`.
- `packages/flynncode/src/effect/runtime-flags.ts`: `disableClaudeHooks` from `OPENCODE_DISABLE_CLAUDE_HOOKS`.
- `packages/flynncode/src/config/claude.ts`: `loadHooks`.
- `packages/flynncode/src/config/config.ts`: append Claude groups after all native hooks, including plugin-bundled native hooks.
- `packages/flynncode/src/hooks/trust.ts`: `HookDef` gets `source?: string`; `fromHandler` carries it; Claude user source counts as trusted. Read `bind`/`bindToInstance` to see how native user hooks are exempted, and mirror that.
- Tests: `packages/flynncode/test/config/claude-hooks.test.ts`.
- Regenerate the legacy SDK (`./packages/sdk/js/script/build.ts`) if the config schema is public. Stage only related generated changes.

**Interfaces:**
- Produces `ConfigClaude.loadHooks(input: { home: string; projectDirs: ReadonlyArray<string>; projectRoot: string; disabled: ReadonlySet<string> }): { hooks: ConfigHooksV1.Info; sources: Array<ClaudeHookSource>; warnings: Array<string> }`. It is synchronous fs reads, or Effect if the module's other loaders are Effect; follow `loadAgents`.
- `ClaudeHookSource = { id: string; kind: "user" | "project" | "plugin"; label: string; root?: string; events: Array<string>; commands: Array<string>; enabled: boolean; warnings: Array<string> }`. Disabled sources are still listed with `enabled: false` and contribute no hooks.
- Every produced group has `format: "claude"`, `source: <id>`, and `env` (`CLAUDE_PROJECT_DIR`, plus `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` for plugins). Commands are already `${…}`-expanded.

- [ ] Failing tests, using a fake HOME dir under TMPDIR with real files:
  - user settings + local settings + a project `.claude/settings.json` + `installed_plugins.json` with two plugins (one enabled with `hooks/hooks.json` using `${CLAUDE_PLUGIN_ROOT}`, one disabled) → correct groups, tags, env and expansion;
  - a missing install path → warning, other sources still load;
  - an invalid JSON file → warning;
  - `claude_hooks.disabled` → listed but no hooks;
  - the flag → nothing loaded;
  - native hooks stay first in the merged config;
  - a plugin hook needs trust and a changed command needs trust again;
  - a user hook does not need trust.
- [ ] Implement.
- [ ] Run `cd packages/flynncode && bun test test/config test/hooks`, `bun typecheck` (flynncode, core).
- [ ] Commit `feat(flynncode): load Claude Code hooks from settings and plugins`.

### Task 2: Claude transcript writer

**Files:**
- Create `packages/flynncode/src/hooks/claude-transcript.ts` and `packages/flynncode/test/hooks/claude-transcript.test.ts`.
- Delete-on-session-delete: find where session deletion removes per-session files (e.g. the session service delete path or the storage sweep) and add the transcript + cursor files.
- Retention: find the history retention sweep from the 2026-10-25 DB retention work (`packages/core/src/database/maintenance*.ts` / `packages/flynncode/src/storage/session-diff-sweep.ts`) and delete transcripts whose session no longer exists.

**Interfaces:**
- Produces `ClaudeTranscript.sync(input: { sessionID: string }): Effect<string>`. It needs the Session service, returns the absolute path, and never fails: it logs and returns the last good path or `""`.
- Produces `ClaudeTranscript.path(sessionID: string): string`.
- Messages come from the Session service's message list (text parts → `text`, tool parts → `tool_use` on the assistant line plus a `tool_result` on a following `user` line, as Claude does).

- [ ] Failing tests, with a real session holding user/assistant/tool messages:
  - sync writes JSONL;
  - a second sync after a new message appends only the new lines;
  - `tail -n 4 file | jq -s .` via a real `sh -c` parses (skip only if `jq` is absent, with a logged reason);
  - deleting the session removes the files;
  - an unwritable dir returns `""` and does not throw.
- [ ] Implement.
- [ ] Run tests + typecheck.
- [ ] Commit `feat(flynncode): keep a Claude-format transcript for hooks`.

### Task 3: Claude input/output format in the executor

**Files:**
- Create `packages/flynncode/src/hooks/claude-format.ts` and `packages/flynncode/test/hooks/claude-format.test.ts`.
- Modify `packages/flynncode/src/hooks/executor.ts`:
  - choose format per group;
  - pass `env`;
  - call `ClaudeTranscript.sync` before a Claude-format spawn;
  - apply Claude exit/JSON/plain-text rules;
  - apply Claude-format matchers to the Claude tool name.
- Modify `packages/flynncode/src/hooks/config.ts` (matching) as needed.
- Update the protocol comment at the top of executor.ts.

**Interfaces:**
- Consumes Task 1 groups (`format`, `source`, `env`) and `ClaudeTranscript.sync` (Task 2).
- Produces, in `ClaudeFormat`:
  - `toolName(id: string): string`
  - `toClaudeArgs(id: string, args: Record<string, unknown>): Record<string, unknown>`
  - `fromClaudeArgs(id: string, args: Record<string, unknown>): { args: Record<string, unknown>; dropped: Array<string> }`
  - `input(event: string, payload: Record<string, unknown>, extra: { transcriptPath: string; permissionMode: string; cwd: string }): Record<string, unknown>`
  - `output(event: string, result: { exitCode: number | null; stdout: string; stderr: string }): <the executor's existing normalized decision/observe/post result type, extended with ask/block as needed>`

- [ ] Failing tests:
  - pure translation tests (names, MCP names, args round-trip, dropped keys);
  - real command-hook tests through the executor with a Claude-format group whose script echoes stdin to a file and prints canned output:
    - stdin has the Claude fields;
    - `Edit|Write` matcher matches `edit`;
    - `mcp__.*` matches an MCP tool;
    - `permissionDecision` allow/deny with `updatedInput` translated back;
    - exit 2 denies with stderr;
    - exit 1 is ignored (native exit 1 still denies);
    - `SessionStart` plain stdout becomes context;
    - `transcript_path` points at an existing file;
    - `CLAUDE_PLUGIN_ROOT` is in env.
- [ ] Implement.
- [ ] Run `bun test test/hooks test/session test/permission` + typecheck.
- [ ] Commit `feat(flynncode): speak Claude's hook format to Claude hooks`.

### Task 4: `ask` decision, `PostToolUseFailure` and `Notification`

**Files:**
- `packages/flynncode/src/hooks/runner.ts`: `PreToolUseDecision` gains `{ behavior: "ask"; message?: string }`; `denyWins` precedence becomes deny > ask > allow > undecided; new `runPostToolUseFailure`, `runNotification`.
- `packages/flynncode/src/hooks/executor.ts`: native `{behavior:"ask"}` parsing; new events in `ObserveEvent`/post handling.
- `packages/flynncode/src/session/tools.ts` (~233-657):
  - an `ask` decision forces the permission prompt for that call even when rules allow. Find how the permission check is invoked and request an explicit ask.
  - the failure path calls `runPostToolUseFailure` instead of `runPostToolUse`.
- `packages/flynncode/src/permission/index.ts` (~170): `Notification` `permission_prompt` when a prompt is shown to the user. Question prompts: find the question tool's ask path outside the off-limits files and fire `question` there.
- `packages/flynncode/src/session/status.ts` (~55): fire `Notification` `idle` for root sessions.
- `PostToolUseFailure` and `Notification` plugin trigger names, if the plugin hook interface lists events (`packages/plugin/src/index.ts`). Add them only if other events are mirrored there.
- Tests in `packages/flynncode/test/hooks/` and `test/session/`.

**Interfaces:**
- `runPostToolUseFailure(input: { sessionID; tool; callID; args; error: string; interrupted: boolean }): Effect<PostToolUseOutcome>`
- `runNotification(input: { sessionID; message: string; type: "permission_prompt" | "question" | "idle" }): Effect<void>`

- [ ] Failing tests (real hooks + the test LLM server):
  - native and Claude `ask` on an allowed tool produce a permission request;
  - deny beats ask;
  - a tool that throws fires `PostToolUseFailure` (not `PostToolUse`) with the error;
  - a permission prompt fires `Notification` `permission_prompt`;
  - a root session idle fires `idle`;
  - existing hook tests unchanged.
- [ ] Implement.
- [ ] Run `bun test test/hooks test/session test/permission` + typecheck.
- [ ] Commit `feat(flynncode): add ask decisions, tool-failure and notification hooks`.

### Task 5: Blocking `Stop`, `SubagentStop` and `UserPromptSubmit`

**Files:**
- `packages/flynncode/src/session/prompt.ts`:
  - At the loop's natural end (no more tool calls, before the session goes idle), run a blocking stop check: `SubagentStop` for sessions with `parentID`, `Stop` otherwise.
  - A block admits the reason as a synthetic user prompt (follow the synthetic-prompt pattern used by background-shell notifications, `packages/flynncode/src/tool/shell/background.ts:15-42`, but continue in the same drain rather than queueing for later), then loops with `stop_hook_active: true`.
  - Count continuations per user prompt; cap at 8, then warn and stop.
  - `UserPromptSubmit` (~1154): a block result prevents admission and returns/surfaces the reason to the caller (find how prompt errors reach the app; the app shows a toast in Task 7).
- `packages/flynncode/src/hooks/runner.ts`:
  - New `runStop(input: { sessionID; subagent: boolean; agentID?: string; agentType?: string; active: boolean }): Effect<{ block: boolean; reason?: string }>`.
  - `runSessionPrompt` result gains `block?: { reason: string }`.
  - The detached `Stop` in `runIdle` (`packages/flynncode/src/session/status.ts:55`) no longer fires the `Stop` event, because it moved to the loop. `Interrupt` and `Notification` idle stay.
  - `task.ts` (off-limits) still calls `runSubagentStop` after the child returns. Make `runSubagentStop` a no-op for a session whose loop already ran `SubagentStop`: the runner keeps a bounded set of such session ids and consumes the id. Then the event fires once and `task.ts` is not edited.
- Tests: `packages/flynncode/test/session/stop-hooks.test.ts`.

- [ ] Failing tests (real command hooks + the test LLM server):
  - a `Stop` hook that blocks once (state file) makes the model get a second request containing the reason, and the second `Stop` input has `stop_hook_active: true`;
  - an always-blocking hook stops after 8 continuations;
  - a `SubagentStop` block continues a child session before the parent gets the result;
  - `SubagentStop` fires exactly once per child;
  - `UserPromptSubmit` exit 2 → the prompt is not admitted and the reason is returned;
  - native `{behavior:"deny"}` blocks too;
  - existing `status-hooks.test.ts` is updated for the moved `Stop`.
- [ ] Implement.
- [ ] Run `bun test test/session test/hooks` + typecheck.
- [ ] Commit `feat(flynncode): let Stop and prompt hooks block`.

### Task 6: `http` and `prompt` handlers

**Files:**
- `packages/flynncode/src/hooks/executor.ts`: execute the two new handler types for every event kind, for native and Claude formats.
- `packages/flynncode/src/hooks/trust.ts`: `HookDef.type` includes `http` and `prompt`, and the hash covers url, headers and prompt.
- For the model call, find how `small_model` is resolved (e.g. title generation or compaction) and reuse it.
- Tests: `packages/flynncode/test/hooks/http-prompt.test.ts`.

**Interfaces:** None new. The handlers return the same normalized results as command hooks.

- [ ] Failing tests:
  - `http` against a real local `Bun.serve`:
    - a decision is honored;
    - the body is the input JSON;
    - headers interpolate only `allowedEnvVars`;
    - a non-2xx response is ignored;
    - a timeout is ignored.
  - `prompt` against the test LLM server:
    - `ok:false` denies `PreToolUse` and blocks `Stop` (continues with the reason);
    - `$ARGUMENTS` is substituted;
    - invalid JSON is ignored.
  - the trust hash changes with the url.
- [ ] Implement.
- [ ] Run tests + typecheck.
- [ ] Commit `feat(flynncode): add http and prompt hook handlers`.

### Task 7: App, API and docs

**Files:**
- Server: extend the hooks trust/config API (`packages/flynncode/src/server/**/handlers/config.ts` ~42-111) with `claudeSources: ClaudeHookSource[]` (from `ConfigClaude.loadHooks`), plus a way to toggle a source. Write `claude_hooks.disabled` to the global Flynncode config file using the same mechanism the app uses for other settings writes.
- Regenerate clients: `cd packages/client && bun run generate`, and the legacy SDK if needed.
- App:
  - `packages/app/src/components/settings-v2/hooks.tsx`: a "Claude Code" section listing each source with its events, commands, warnings and an on/off switch.
  - The trust prompt names the source.
  - A blocked prompt shows a toast with the reason.
  - A `Stop` continuation uses the existing "Background activity" divider.
- i18n: keys in `packages/app/src/i18n/en.ts` + `flynncode-fallback.ts`, plus `packages/ui/src/i18n/*` if strings live there, keeping parity tests green.
- Docs: `packages/web/src/content/docs/hooks-reference.mdx` documents the Claude sources, formats, new events/decisions, handler types, the 8-continuation cap, the transcript file and the timeouts (command 600 s, http/prompt 60 s).
- A browser test for the sources section helper.

- [ ] Failing browser test → implement.
- [ ] Run `cd packages/app && bun test --conditions=browser --preload ./happydom.ts ./test-browser`, the app i18n tests, `bun typecheck` (app, ui, session-ui, flynncode, client), and the server route tests.
- [ ] Run prettier on touched files only.
- [ ] Commit `feat(app): show and toggle Claude Code hook sources`.

### Task 8: Spec sync and verification

- [ ] Update the spec where the implementation differs, including the timeout clarification (command 600 s; http/prompt 60 s).
- [ ] Run:
  - `cd packages/flynncode && bun test test/hooks test/session test/permission test/config && bun typecheck`
  - `cd packages/core && bun typecheck`
  - `cd packages/app && bun test --conditions=browser --preload ./happydom.ts ./test-browser && bun typecheck`
- [ ] Classify failures without `git stash`. Known pre-existing: `test/session/instruction.test.ts:283` reads the real `~/.claude/CLAUDE.md`.
- [ ] Commit `docs: sync Claude hooks spec with the implementation`.
