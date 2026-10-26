# Claude Compatibility Pack Design

Date: 2026-10-26
Status: implemented (this document describes the shipped behavior)

## Problem

The owner uses Claude Code and Flynncode side by side. Flynncode already reads
`.claude/skills`, but it ignores `.claude/agents` and `.claude/commands`. Its
plan mode is CLI-only and behind an experimental flag. It has no MultiEdit or
NotebookEdit tool, and its LSP tool is experimental. This pack makes a Claude
Code setup work in Flynncode unchanged and matches Claude Code's planning and
editing behavior.

This is workstream 2 of 4 from the 2026-10-26 agent-parity gap analysis:
1. background shells (done);
2. this pack;
3. deferred MCP tools;
4. hooks, scheduling and worktree tools.

## Decisions

- **Model aliases.** A `.claude` agent's `model: opus | sonnet | haiku` resolves to the newest connected Anthropic model of that family (providers `anthropic`, `anthropic-api`, `opencode` and `vercel`; newest `release_date` first). If `inherit` is given, or no such model is available, the session's current model is used. An unresolved alias is logged as a warning; the planned one-line note in the task result is deferred because it needs changes to `task.ts`. A full `provider/model` id is used as-is. Any other value (for example a bare `claude-…` id) produces a warning and runs on the session model.
- **Plan mode is Claude-style.**
  - The agent may enter plan mode itself.
  - Exiting plan mode shows an approval card with three outcomes: approve and auto-accept edits, approve and ask for each edit, or keep planning with feedback.
  - Shift+Tab cycles build → plan → build.
- **LSP.** The tool is on by default. When the `lsp` config key is unset, language servers start lazily on first use of the `lsp` tool and stop after 10 idle minutes, with at most 3 running per server process.

## Design

### `.claude/agents`

**Sources.**
- `~/.claude/agents/**/*.md` and `.claude/agents/**/*.md` found by walking up from the instance directory to the worktree. Closer project files override farther ones, and project files override user files.
- A Flynncode-native agent (inline config or `.opencode` markdown) with the same name wins entirely, and one warning is logged per clash.
- A built-in agent (for example `explore`) cannot be overridden by a same-named Claude agent; the Claude file is ignored with a warning.
- There is no file watcher. `.claude` files are read when config loads, the same as `.opencode` ones, so edits apply when config reloads.
- `OPENCODE_DISABLE_CLAUDE_CODE_AGENTS` (or `OPENCODE_DISABLE_CLAUDE_CODE`) turns the source off; project directories are also skipped under `OPENCODE_DISABLE_PROJECT_CONFIG`.

**Mapping.**
- **Name, description and prompt.** `name` and `description` are used as-is, and the Markdown body becomes the system prompt. Agents load as `mode: subagent`, so they appear as task `subagent_type` choices.
- **Tools.** `tools` is a comma-separated list mapped to Flynncode tools:

  | Claude name | Flynncode tool |
  |---|---|
  | Read | read |
  | Write | write |
  | Edit | edit |
  | MultiEdit | multiedit |
  | Bash | bash |
  | Glob | glob |
  | Grep | grep |
  | WebFetch | webfetch |
  | WebSearch | websearch |
  | TodoWrite | todowrite |
  | Task | task |
  | NotebookEdit | notebook_edit (`edit` permission on `*.ipynb`) |
  | AskUserQuestion | question |

  - Write, Edit and MultiEdit all map to the `edit` permission, because write and `apply_patch` run under it. NotebookEdit maps to the `edit` permission for `*.ipynb` paths only, which is what `notebook_edit` asks.
  - `mcp__server__tool` becomes `server_tool` and `mcp__server` becomes `server_*`, which is how Flynncode names MCP tools. An `mcp__` entry whose derived name equals or matches a built-in permission key (for example `mcp__bash`) is dropped with a warning, so an MCP name cannot grant a built-in.
  - Unknown names are skipped with a warning.
  - With no `tools` field, the agent gets every tool, as in Claude Code.
  - A `tools` list only restricts; it never grants. A `.claude` file comes from a repository, so it is untrusted. The list emits no allow rules. Every built-in permission it does not cover is denied, and `Permission.restrict` narrows the agent's merged ruleset (defaults, then the user's config) to the listed tools: anything outside them, MCP and plugin tools included, is denied and hidden, while a listed tool keeps exactly the rule the defaults and user config give it (`bash: ask` stays ask, a `.env` read still asks). `external_directory` and `doom_loop` keep their standing rules. Where a standing rule only partly overlaps a listed scope (for example a user `src/*: ask` edit rule and NotebookEdit's `*.ipynb`), the overlap is restricted: an allow is dropped and an ask becomes a deny.
  - The agent decode keeps the original key order (`propertyOrder: "original"`), which permission precedence depends on.
- **Model.** `model` resolves as described under Decisions.
- **Color.** `color` sets the sub-agent chip color: red maps to error, orange and yellow to warning, green to success, blue and cyan to info, purple to accent, pink to secondary. `#RRGGBB` is kept; other names are dropped.

### `.claude/commands`

**Sources.**
- `~/.claude/commands/**/*.md` and `.claude/commands/**/*.md` found by walking up from the instance directory to the worktree. Project files override user files.
- Subfolders are namespaced: `git/pr.md` becomes `/git:pr`.
- A Flynncode-native command with the same name wins, with one warning per clash. A Claude command named like a built-in command (`init`, `review`) is ignored with a warning.
- There is no file watcher; files reload with config, like `.opencode` ones.
- `OPENCODE_DISABLE_CLAUDE_CODE_COMMANDS` (or `OPENCODE_DISABLE_CLAUDE_CODE`) turns the source off.

**Frontmatter.**
- `description` and `argument-hint` show in the command picker.
- `model` uses the same alias mapping as agents.
- `allowed-tools` grants those tool patterns without asking, for the turn that answers the command and no longer. It uses the same syntax as Claude, e.g. `Bash(git add:*)` becomes the bash rule `git add *`. The grants are stored on that turn's user message, never in the session permission, and expire with the turn.
  - It can turn a blanket ask into an allow, but never overrides a deny rule or a specific ask rule (such as `git push *` or a `.env` read rule).
  - It never pre-authorizes the command's own `` !`…` `` lines or `@path` references.
  - `NotebookEdit` grants the `edit` permission for `*.ipynb` paths only.
  - `mcp__` entries naming built-in permissions are dropped with a warning. Tool entries with a specifier other than `Bash(...)`, such as `Read(./x/**)`, are ignored with a warning.
  - It does not reach commands that run as subtasks (agent mode `subagent` or `subtask: true`) or tool calls made inside code mode, because those paths build their own permission rulesets.
- `disable-model-invocation: true` is parsed and exposed on the command info. Flynncode has no tool through which the agent invokes slash commands, so nothing enforces it yet; it is carried for when such a tool exists.
- `argument-hint` is shown in the slash picker of the app.

**Body.**
- `$ARGUMENTS` and `$1`…`$9` substitution, which already exists.
- `@path` references are replaced with the file's contents. A reference from a command template (native or Claude) is read through the read tool's own checks: the `read` permission (a `.env` file asks) and `external_directory` for files outside the project, under the agent and session rules. A file the user types or attaches in the composer is still read directly.
- `` !`command` `` runs before the prompt is sent, in the instance directory, and its output is inlined. This applies to native commands as well as Claude ones.
  - Each line goes through the same bash and external-directory permission check as the `bash` tool, using the agent and session rules only. Under the default policy (`"*": "allow"`) a native command's line runs without asking; under `bash: ask` it asks. The readonly sandbox blocks it.
  - A Claude command's line asks unless a specific (non-`*`) allow rule covers it, such as `"git log *": "allow"`; a blanket `"*": "allow"` or `bash: allow` is not enough, because the file ships with a repository. A specific rule approved with "always" earlier in the session also counts.
  - The asks run in order and nothing executes until every line is approved.
  - If the user denies one, the command is aborted with an error naming the line and the reason; no message is created and the model is not called.

### Plan mode

**`enter_plan_mode { reason }`**
- Available to primary agents in clients that have the question tool (app, desktop and CLI, or `OPENCODE_ENABLE_QUESTION_TOOL`), because `exit_plan_mode` waits on a question card; other clients (for example ACP) get neither plan tool. Not offered to sub-agents or the plan agent, and refused with an error inside sub-agent sessions.
- Switches the session to the `plan` agent (read-only; edits are allowed only to the plan file) by inserting a synthetic user message for the plan agent, and returns immediately.
- The app transcript shows "Switched to plan mode — reason" with an **Undo** link, shown only on the most recent such card and only while plan mode is still active.

**`exit_plan_mode { plan }`**
- Available to the plan agent in clients that have the question tool (no CLI-only flag). It replaces the earlier `plan_exit` tool, and `enter_plan_mode` replaces `plan_enter`. Legacy `plan_enter` and `plan_exit` permission keys in config are mapped to the new names.
- Non-interactive `flynncode run` denies both plan tools.
- Writes the plan to the session's plan file and shows an approval card with the rendered plan:
  - **Approve — auto-accept edits:** switch to `build` with approval mode `accept-edits`.
  - **Approve — ask for each edit:** switch to `build` with approval mode `manual`.
  - **Keep planning:** the user's feedback text is returned to the agent, which stays in plan mode.
- If the approval mode is already `auto`, approving keeps it `auto`.
- The call blocks until the user decides, as a question with `custom: true`. Dismissing it counts as keeping the plan. Any free text in the card is returned as feedback.
- After approval, the same turn continues in build mode, driven by a synthetic user message.
- An unanswered card stays pending across reloads, because it is an ordinary pending question.
- The plan file is overwritten with the `plan` argument on every call.
- The server reports the chosen approval in the tool metadata (`approved`, `approval`, `planPath`); the approval-mode switch itself is made by the client. The app reacts to plan tools only on live events, never when replaying history, and the TUI switches agent only when the call was approved.

**Mode cycling.** Shift+Tab in the composer cycles build → plan → build. The current mode shows beside the agent name. Switching agents this way is the same as picking one in the agent picker.

### New tools

**`multiedit { file_path, edits: [{ old_string, new_string, replace_all? }] }`**
- Applies the edits in order, all or nothing. If an `old_string` is missing, or matches more than once without `replace_all`, nothing is written and the error names that edit.
- Mirrors `edit`: the same `edit` permission, fuzzy matchers, line-ending handling, per-path lock, format step, diff metadata, snapshot and LSP touch. `edit` has no read-before-edit rule, so neither does `multiedit`.
- Creating a file works the same way as in `edit`: the file is absent and the first edit has an empty `old_string`.
- Hidden on GPT-family models together with `edit` and `write`, which use `apply_patch`.
- Clients render it like `edit` (diff from the `filediff` metadata, path from `file_path`): the app timeline and changed-files history, the session UI, and ACP, which reports it as an edit tool with one diff per edit. The system prompt lists it among the editing tools.

**`notebook_edit { notebook_path, cell_id?, new_source, cell_type?, edit_mode: replace | insert | delete }`**
- Edits `.ipynb` cells.
- Keeps the notebook's JSON formatting and other cells' outputs, and clears outputs and execution count on the edited cell. Retyping a cell to `code` drops its `attachments`, which nbformat 4 allows on markdown and raw cells only.
- Uses the `edit` permission. Only nbformat 4 notebooks are accepted.
- `read` on an `.ipynb` file shows each cell's id and type, and falls back to raw text when the JSON is invalid. The rendered cells follow the normal offset, limit and 50 KB caps.
- Stays available on GPT-family models, because `apply_patch` cannot edit notebooks safely.
- Clients render it like `edit`, with the notebook path from `notebook_path`; ACP reports it as an edit tool.
- No formatter or LSP touch runs after a write, since that would reformat the JSON. A JSON round trip can lose number formatting such as `1.0` and `\uXXXX` escapes.

### LSP

- The `lsp` tool is registered by default, with no experimental flag; the old `OPENCODE_EXPERIMENTAL_LSP_TOOL` flag is gone.
- Lazy mode applies when the `lsp` config key is unset:
  - Built-in servers are available to the `lsp` tool only. `read`, `edit`, `write` and the other tools that touch files do not start them, though they reuse a server that is already running.
  - A server starts on the first `lsp` call for a file type.
  - Lazy mode never auto-downloads a server; only servers already installed are used. Project-local binaries (`node_modules/.bin`, for example the TypeScript and Biome servers) and binaries on `PATH` still count as installed; servers cached by an earlier eager download are not used. Set `lsp: true` or an object to allow downloads.
- `lsp: true` or an object keeps the eager behavior, plus the idle stop and the cap.
- `lsp: false` turns it all off: the tool is not registered.
- At most 3 servers run per Flynncode process (not per instance); the least recently used one is evicted to make room. A server idle for 10 minutes is stopped by a sweep that runs every minute. Concurrent first calls for the same server share one spawn.
- Servers run in their own process group and are stopped with SIGTERM then SIGKILL on the group; they also stop when the instance is disposed or the process exits. The client reports its parent's pid as `processId`.
- A server that exits on its own is marked broken and is not respawned in a loop.
- A missing language server returns "no language server for .<ext>".

## Error handling

- A malformed `.claude` agent or command file is skipped with a warning naming the file; other files still load.
- Tool-name and model-alias mapping problems produce warnings, never failures.
- A denied or rejected `` !`command` `` aborts its command with the reason shown.
- `multiedit` is atomic: a failed edit means no write.
- `notebook_edit` validates the notebook JSON and refuses unknown cell ids.
- LSP start failures return a clear message, and never crash the session.

## Testing

All tests use real files and processes, with no mocks.

1. **Agents:**
   - user and project sources load, and project overrides user;
   - tool mapping (known, unknown and MCP names);
   - model alias, `inherit` and unavailable fallback;
   - native-agent precedence;
   - a malformed file is skipped.
2. **Commands:**
   - namespacing;
   - `$ARGUMENTS` and `$1`;
   - `@file`;
   - `` !`cmd` `` allowed and denied;
   - `allowed-tools` applies to that turn only, and never overrides deny or specific ask rules or pre-authorizes `!` lines;
   - `disable-model-invocation`.
3. **Plan mode:**
   - enter switches the agent;
   - enter is refused in a sub-agent session;
   - exit shows the card;
   - each of the three outcomes sets the agent and approval mode;
   - `auto` is preserved;
   - feedback reaches the agent.
4. **multiedit:** all-or-nothing behavior, the ambiguity error, and the permission check.
5. **notebook_edit:** replace, insert and delete; other cells' outputs are preserved.
6. **LSP:** lazy start, idle stop (`TestClock`), the 3-server cap, orphan checks on the process group, and the missing-server message.
7. **App:** helpers behind the approval card and Shift+Tab mode cycling (browser suite).

## Out of scope

- Deferred MCP tools, and hooks/scheduling/worktree tools (own specs).
- Claude Code `settings.json` permission import (already covered by config import).
- Output styles and status line.
