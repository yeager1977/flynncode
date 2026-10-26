# Claude Compatibility Pack Design

Date: 2026-10-26
Status: approved design, pending implementation plan

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

- **Model aliases.** A `.claude` agent's `model: opus | sonnet | haiku` resolves to the newest connected Anthropic model of that family. If `inherit` is given, or no such model is available, the session's current model is used and the task result carries a one-line note. A full `provider/model` id is used as-is.
- **Plan mode is Claude-style.**
  - The agent may enter plan mode itself.
  - Exiting plan mode shows an approval card with three outcomes: approve and auto-accept edits, approve and ask for each edit, or keep planning with feedback.
  - Shift+Tab cycles build → plan → build.
- **LSP.** The tool is on by default. Language servers start lazily on first use and stop after 10 idle minutes, with at most 3 running per server process.

## Design

### `.claude/agents`

**Sources.**
- `~/.claude/agents/*.md` and `<project>/.claude/agents/*.md`. Project files override user files.
- A Flynncode-native agent with the same name wins, and a one-line warning is logged.
- Files are watched, so edits apply without a restart.

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
  | NotebookEdit | notebook_edit |
  | AskUserQuestion | question |

  - `mcp__server__tool` names pass through unchanged.
  - Unknown names are skipped with a warning.
  - With no `tools` field, the agent gets every tool, as in Claude Code.
- **Model.** `model` resolves as described under Decisions.
- **Color.** `color` sets the sub-agent chip color.

### `.claude/commands`

**Sources.**
- `~/.claude/commands/**/*.md` and `<project>/.claude/commands/**/*.md`. Project files override user files.
- Subfolders are namespaced: `git/pr.md` becomes `/git:pr`.
- A Flynncode-native command with the same name wins.
- Files are watched.

**Frontmatter.**
- `description` and `argument-hint` show in the command picker.
- `model` uses the same alias mapping as agents.
- `allowed-tools` grants those tool patterns without asking, for that command's turn only. It uses the same syntax as Claude, e.g. `Bash(git add:*)`.
- `disable-model-invocation: true` hides the command from the agent; only the user can invoke it.

**Body.**
- `$ARGUMENTS` and `$1`…`$9` substitution, which already exists.
- `@path` references are replaced with the file's contents.
- `` !`command` `` runs before the prompt is sent, through the normal `bash` permission check, and its output is inlined. If the user denies it, the command is aborted with the reason shown.

### Plan mode

**`enter_plan_mode { reason }`**
- Available to primary agents in every client. Refused inside sub-agent sessions.
- Switches the session to the `plan` agent (read-only; edits are allowed only to the plan file) and returns immediately.
- The transcript shows "Switched to plan mode — reason" with an **Undo** link.

**`exit_plan_mode { plan }`**
- Available to the plan agent in every client (no CLI-only flag).
- Writes the plan to the session's plan file and shows an approval card with the rendered plan:
  - **Approve — auto-accept edits:** switch to `build` with approval mode `accept-edits`.
  - **Approve — ask for each edit:** switch to `build` with approval mode `manual`.
  - **Keep planning:** the user's feedback text is returned to the agent, which stays in plan mode.
- If the approval mode is already `auto`, approving keeps it `auto`.
- The call blocks until the user decides, like a question.
- After approval, the same turn continues in build mode.
- An unanswered card stays pending across reloads.

**Mode cycling.** Shift+Tab in the composer cycles build → plan → build. The current mode shows beside the agent name. Switching agents this way is the same as picking one in the agent picker.

### New tools

**`multiedit { file_path, edits: [{ old_string, new_string, replace_all? }] }`**
- Applies the edits in order, all or nothing. If an `old_string` is missing, or matches more than once without `replace_all`, nothing is written and the error names that edit.
- Same read-before-edit rule, `edit` permission, diff metadata and snapshot as `edit`.
- Replaced by `apply_patch` on GPT-family models, like `edit`.

**`notebook_edit { notebook_path, cell_id?, new_source, cell_type?, edit_mode: replace | insert | delete }`**
- Edits `.ipynb` cells.
- Keeps the notebook's JSON formatting and other cells' outputs, and clears outputs and execution count on the edited cell.
- Uses the `edit` permission.
- `read` on an `.ipynb` file shows each cell's id.

### LSP

- The `lsp` tool is registered by default, with no experimental flag.
- Language servers start lazily on the first `lsp` call for a file type, with at most 3 running per server process.
- A server idle for 10 minutes is stopped.
- Servers are tracked child processes that die with the server.
- A missing language server returns "no language server for .<ext>".
- Explicit `lsp` config still overrides; for example `lsp: false` turns it all off.

## Error handling

- A malformed `.claude` agent or command file is skipped with a warning naming the file; other files still load.
- Tool-name and model-alias mapping problems produce warnings, never failures.
- A denied `` !`command` `` aborts its command with the reason shown.
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
   - `allowed-tools` applies to that turn only;
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
6. **LSP:** lazy start, idle stop (injectable clock), the 3-server cap, and the missing-server message.
7. **App:** helpers behind the approval card and Shift+Tab mode cycling (browser suite).

## Out of scope

- Deferred MCP tools, and hooks/scheduling/worktree tools (own specs).
- Claude Code `settings.json` permission import (already covered by config import).
- Output styles and status line.
