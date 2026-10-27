# Claude-Compatible Hooks Design

Date: 2026-10-27
Status: approved design, pending implementation plan

## Problem

Flynncode has a native hook system with most of Claude Code's events, a trust
gate and a settings page. It cannot run hooks written for Claude Code:

- It never reads `~/.claude/settings.json`, project `.claude/settings*.json` or the hooks of enabled Claude plugins.
- Its stdin payload and stdout decision format differ from Claude's.
- It has no `Notification` or `PostToolUseFailure` event and no `ask` decision.
- `Stop` and `SubagentStop` cannot block. `UserPromptSubmit` cannot block either.
- It has no `http` or `prompt` handler types.

The owner's enabled Claude plugins already carry hooks:
- **superpowers** has a `SessionStart` hook that adds context.
- **double-shot-latte** has a `Stop` hook. It reads `transcript_path` with `tail | jq`, asks `claude` whether work remains, and blocks the stop to continue.
- **claude-session-driver** has `PreToolUse` and event hooks. They are inert outside its worker sessions.

This spec is part 1 of workstream 4 of the 2026-10-26 agent-parity plan. The parts, in the order chosen on 2026-10-27, are:
1. Claude-compatible hooks (this spec);
2. agent scheduling;
3. worktree tools;
4. a scriptable status line.

## Decisions

- **Run Claude hooks from all three places:**
  - Claude user settings;
  - Claude project settings;
  - every Claude plugin enabled in Claude.
- **Mirror Claude and trust once.** Plugins follow Claude's `enabledPlugins` automatically.
  - Plugin hooks and project `.claude` hooks pass through the existing hook trust prompt once, and again whenever their commands change.
  - Each source has an on/off switch on the Hooks settings page.
- **Use a translation layer in the existing runner.** Claude hooks join the existing hook runner tagged with the Claude format. Native hooks keep their format. New events and handler types apply to both.

## Design

### Sources and loading

Claude hook sources are merged beneath native hooks. Native hooks run first within each event.

| Source | Files |
|---|---|
| Claude user | `~/.claude/settings.json`, `~/.claude/settings.local.json` (`hooks` key) |
| Claude project | `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`, using the same project `.claude` directories the compat pack already walks (`claudeDirs` in `packages/flynncode/src/config/config.ts`) |
| Claude plugin | For each `name@marketplace` set to `true` in `~/.claude/settings.json` `enabledPlugins`: its entry in `~/.claude/plugins/installed_plugins.json` (version 2 format), preferring the `user`-scope install, then the last listed. Hooks come from `<installPath>/hooks/hooks.json` (`hooks` key). |

- Loading lives in the compat pack (`packages/flynncode/src/config/claude.ts`), as a settings and plugin hook loader called from the config loader.
- Every loaded matcher group is tagged with:
  - its source, e.g. `claude:user`, `claude:project:<dir>` or `claude:plugin:<name@marketplace>`;
  - `format: "claude"`.

**Variables:**
- `${CLAUDE_PLUGIN_ROOT}`, the plugin's install path, and `${CLAUDE_PROJECT_DIR}`, the project root, are expanded in commands. They are also set as environment variables.
- Plugin hooks also get `CLAUDE_PLUGIN_DATA`, which is `~/.claude/plugins/data/<plugin-id>`.

**Trust:**
- Claude user hooks are trusted, like native user hooks.
- Claude project hooks and plugin hooks go through the existing trust check (`packages/flynncode/src/hooks/trust.ts`), keyed by a hash of the source's commands. A changed command asks again.
- The trust prompt names the plugin or project file.

**Kill switches:**
- `disableAllHooks` still disables everything.
- `OPENCODE_DISABLE_CLAUDE_HOOKS=1` disables only the Claude sources.
- `OPENCODE_DISABLE_CLAUDE_CODE` disables them too, as it does the rest of the compat pack.
- A per-source switch on the Hooks settings page is stored in Flynncode config as `claude_hooks.disabled: string[]` of source ids.

**Not imported:** permissions, env, model or other settings from Claude settings files, and commands, agents, skills or MCP servers from Claude plugins.

### Claude input format

A Claude-format hook gets this JSON on stdin.

| Field | Events |
|---|---|
| `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name` | all |
| `tool_name`, `tool_input`, `tool_use_id` | `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure` |
| `tool_response` | `PostToolUse` |
| `error`, `is_interrupt` | `PostToolUseFailure` |
| `prompt` | `UserPromptSubmit` |
| `source` (`startup`, `resume`, `clear`, `compact`) | `SessionStart` |
| `reason` | `SessionEnd` |
| `trigger` (`manual`, `auto`), `custom_instructions` | `PreCompact` |
| `stop_hook_active` | `Stop`, `SubagentStop` |
| `agent_id`, `agent_type` | `SubagentStart`, `SubagentStop` |
| `message`, `notification_type` | `Notification` |

**Translation:**
- **Tool names** are translated to Claude's by reversing the compat pack's Claude-to-Flynncode tool map (`TOOLS` in `claude.ts`), e.g. `bash` → `Bash`, `edit` → `Edit`, `task` → `Task`. MCP tools become `mcp__<server>__<tool>`. A tool with no Claude name passes through under its Flynncode id.
- **Argument keys** of translated tools are converted from camelCase to Claude's snake_case, e.g. `filePath` → `file_path`, `oldString` → `old_string`.
- **Matchers** of Claude-format groups are tested against the Claude tool name.

### Claude output format

| Result | Meaning |
|---|---|
| Exit 2 | Behaviour depends on the event, below. |
| Exit 0, stdout is a JSON object | The JSON decision, below. |
| Exit 0, stdout is plain text | Added as context on `SessionStart` and `UserPromptSubmit`; ignored elsewhere. |
| Any other exit, a timeout, or a failure to start | Logged and ignored (Claude's non-blocking error). |

**What exit 2 does on each event:**
- `PreToolUse` and `PermissionRequest`: deny the call, and stderr goes to the model.
- `PostToolUse` and `PostToolUseFailure`: stderr goes to the model.
- `UserPromptSubmit`: the prompt is not sent, and stderr is shown to the user.
- `Stop` and `SubagentStop`: block the stop, and stderr becomes the continuation reason.
- Other events: stderr is logged.

**JSON fields read:**
- `continue: false` with `stopReason`: end the turn and show the reason.
- `systemMessage`: shown to the user.
- `decision: "block"` with `reason`:
  - on `PostToolUse` the reason goes to the model;
  - on `UserPromptSubmit` the prompt is blocked;
  - on `Stop` and `SubagentStop` the stop is blocked.
- `hookSpecificOutput.permissionDecision`, which is `allow`, `deny` or `ask`, with `permissionDecisionReason`, on `PreToolUse`.
- `hookSpecificOutput.updatedInput` on `PreToolUse`, translated back to Flynncode argument names. Keys that don't map are dropped with a warning.
- `hookSpecificOutput.additionalContext` on `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `PostToolUseFailure`, through the existing context handling (`packages/flynncode/src/hooks/context.ts`).

### New for all hooks

**`ask` decision.**
- A `PreToolUse` hook can return `ask`: native `{ behavior: "ask" }` or Claude `permissionDecision: "ask"`. It forces the normal permission prompt even when a rule would allow the call.
- Deny beats ask, and ask beats allow.

**`PostToolUseFailure`.**
- It fires instead of `PostToolUse` when a tool errors or is aborted.
- Its input carries the error text and whether the tool was interrupted.

**`Notification`.**
- It fires when a permission prompt or question waits for the user (`notification_type`: `permission_prompt` or `question`), and when a root session goes idle after a turn (`idle`).
- It is observe-only.

**Blocking `Stop` and `SubagentStop`.**
- These run at the end of the prompt loop, before the session goes idle, instead of detached after idle.
- A block queues its reason as a synthetic user prompt and the loop continues. The next `Stop` input has `stop_hook_active: true`.
- At most 8 forced continuations are allowed per user prompt. After that the stop is allowed and a warning is logged.
- `SubagentStop` blocking continues the sub-agent before it returns its result.

**Blocking `UserPromptSubmit`.**
- Exit 2, a block decision or `ok: false` stops the prompt being admitted.
- The user sees the reason.

**Native-format blocking.** A native hook blocks `Stop`, `SubagentStop` or `UserPromptSubmit` the same way it denies a tool: exit 2 (stderr is the reason) or `{ "behavior": "deny", "message": "<reason>" }`. Other native output on these events keeps its current meaning.

### Handler types

**`http`:** `{ type: "http", url, headers?, allowedEnvVars?, timeout? }`.
- It POSTs the hook input as JSON.
- `$VAR` and `${VAR}` in header values are filled in only for variables named in `allowedEnvVars`; others become empty.
- A 2xx JSON body is read as the hook's JSON output, in the hook's format.
- A non-2xx status, a timeout, a network error or a body that isn't JSON is logged and ignored. HTTP has no exit-2 equivalent.

**`prompt`:** `{ type: "prompt", prompt, model?, timeout? }`.
- `$ARGUMENTS` in `prompt` is replaced with the hook input JSON. If it is absent, the input is appended.
- The model is `model` if set, else the configured `small_model`, else the session's model. It must answer `{ "ok": boolean, "reason"?: string }`.
- `ok: false` blocks: it denies on `PreToolUse`, blocks the prompt on `UserPromptSubmit`, and continues with the reason on `Stop` and `SubagentStop`. On other events it is logged.
- A model error or an answer that isn't valid JSON is logged and ignored.

**Timeouts:** the default is 60 s for every handler type. A handler's `timeout` (seconds, as in Claude) overrides it.

**Not included:** Claude's multi-turn `agent` handler type.

### Transcript file

Right before a Claude-format hook runs for a session, Flynncode brings `Global.Path.data/claude-transcripts/<sessionID>.jsonl` up to date.

- **Line format:** one JSON object per message, in Claude Code's transcript line format: `type` (`user` or `assistant`), `message` (`role`, `content` blocks: `text`, `tool_use`, `tool_result`), `uuid`, `parentUuid`, `timestamp`, `sessionId` and `cwd`.
- **Updating:** only messages added since the last update are appended. The last written message id is kept in a sidecar file.
- **When it exists:** it is created only for sessions where a Claude-format hook runs.
- **Cleanup:** it is deleted with its session and covered by the existing history retention.
- **Failure:** a failed write is logged and the hook still runs, with the last good path or an empty `transcript_path`.

### App

- **Hooks settings page** (`packages/app/src/components/settings-v2/hooks.tsx`):
  - a "Claude Code" section listing Claude user, Claude project and each plugin;
  - for each source: its events and commands, an on/off switch and any load warnings.
- **Trust prompt:** names the plugin or project file.
- **Forced continuation:** a `Stop` hook continuation uses the existing compact "Background activity" divider for synthetic prompts, showing the hook's reason.
- **Blocked prompt:** shows a toast with the reason.
- **Docs:** `packages/web/src/content/docs/hooks-reference.mdx` documents the Claude sources, the formats, the new events and decisions, and the handler types.

## Error handling

- **Bad sources:** a missing plugin install path, an unreadable or invalid `hooks.json` or `settings.json`, or an unknown event or handler type is skipped. It appears as a warning on the Hooks settings page and in the log. Other hooks are unaffected.
- **Missing files:** a disabled or missing `installed_plugins.json` means no plugin hooks; it is not an error.
- **Contained failures:** a failing Claude hook never fails a turn. Only exit 2, a block decision, `deny`, `ask` or `ok: false` changes behaviour.
- **Native hooks unchanged:** they keep their current semantics, including deny-on-error for decision hooks.

## Testing

All tests use real processes and servers, no mocks.

1. **Loading:**
   - a fake `HOME` with `.claude/settings.json`, `settings.local.json`, `plugins/installed_plugins.json` and a plugin directory with `hooks/hooks.json` loads every source;
   - variables expand;
   - disabled plugins and switched-off sources don't run;
   - `OPENCODE_DISABLE_CLAUDE_HOOKS` turns them all off.
2. **Trust:**
   - plugin and project hooks ask once;
   - a changed command asks again;
   - user hooks don't ask.
3. **Format:**
   - stdin carries Claude fields and names;
   - `Edit|Write` and `mcp__.*` matchers match;
   - `updatedInput` is translated back.
4. **Decisions:**
   - `PreToolUse` allow, deny, ask and exit 2;
   - native `ask`;
   - deny beats ask.
5. **Events:**
   - `SessionStart` plain stdout becomes context;
   - `PostToolUseFailure` fires on a tool error;
   - `Notification` fires on a permission prompt and on idle;
   - `UserPromptSubmit` exit 2 blocks.
6. **Stop:**
   - a block continues the turn through the test LLM server, with `stop_hook_active: true` on the next call;
   - the 8-continuation cap ends a loop;
   - `SubagentStop` blocks a sub-agent.
7. **Handlers:**
   - `http` against a local server (decision, non-2xx ignored, env interpolation limited to `allowedEnvVars`);
   - `prompt` against the test LLM server (`ok: false` denies, invalid JSON ignored).
8. **Transcript:**
   - the JSONL is appended incrementally;
   - `tail -n 4 | jq -s .` parses it, as the double-shot-latte hook does;
   - it is deleted with the session.
9. **No regressions:** existing native hook tests pass unchanged.
10. **App:** the Claude sources section and its switch (browser suite).

## Out of scope

- Claude settings other than hooks, and plugin commands, agents, skills or MCP servers.
- The `agent` handler type.
- Agent scheduling, worktree tools and the status line (own specs).
