# Scriptable Status Line Design

Date: 2026-10-28
Status: approved design, pending implementation plan

## Problem

Claude Code's `statusLine` setting runs a user command with session JSON on stdin and shows its output at the bottom of the screen. Flynncode has nothing like it: the TUI session footer is hardcoded, and the desktop app has no status line.

This is part 4 of workstream 4 of the 2026-10-26 agent-parity plan. Parts 1–3 are done: Claude-compatible hooks, agent scheduling and worktree tools.

## Decisions

- **Shown in both the desktop app and the TUI**, driven by one config.
- **The server runs the command.** It runs per session, throttled, and publishes the result as an event. Clients only render it, so this also works for clients that cannot run commands, such as the browser app and remote servers.

## Design

### Config

`statusLine: { type: "command", command: string, padding?: number }` in Flynncode config. This is the same shape as Claude Code's.

When no native `statusLine` is set, Flynncode falls back to a `statusLine` found in Claude settings: `~/.claude/settings.json` and `settings.local.json`, then the project `.claude/settings.json` and `settings.local.json`, using the same directories the compat pack walks.
- Commands from Claude settings go through the hook trust check (`HooksTrust`), the same as Claude hooks.
- `OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_CLAUDE_HOOKS` turn the fallback off.

### Input

The command gets Claude Code's status JSON on stdin.

| Field | Value |
|---|---|
| `hook_event_name` | `"Status"` |
| `session_id`, `transcript_path`, `cwd`, `version` | From the session. `transcript_path` uses the Claude-format transcript writer from the hooks work. |
| `model` | `{ id, display_name }` |
| `workspace` | `{ current_dir, project_dir }` |
| `output_style` | `{ name }`, set to the current agent's name |
| `cost` | `{ total_cost_usd, total_duration_ms, total_api_duration_ms, total_lines_added, total_lines_removed }` |
| `exceeds_200k_tokens` | Boolean |
| `context` | Flynncode extra: `{ used_tokens, limit }` |

**Environment:** the command runs in the session's working directory with Flynncode's environment, plus `CLAUDE_PROJECT_DIR`.

### When it runs

- **What triggers a run:** a change to the session's messages, model, agent, folder or status. Runs are throttled to at most one per 300 ms per session.
- **On open:** a client opening a session with no fresh result also triggers a run.
- **Overlap:** a run that is still going when the next is due causes that next run to be skipped, not queued.
- **Timeout:** a run is killed after 5 s.
- **No config, no work:** with no status line configured, nothing runs and nothing subscribes.

### Output and delivery

- **Lines:** the first 2 non-empty stdout lines, each capped at 200 characters.
- **Formatting:** ANSI SGR codes are allowed. `padding` adds horizontal spacing.
- **Event:** the server publishes `session.statusline { sessionID, lines }` and keeps the last result per session.
- **Route:** `GET /session/{id}/statusline` returns the last result `{ lines, updatedAt }` and starts a run if the result is stale or missing.
- **SDK:** `client.session.statusline.get`.

### Display

- **Desktop app:** a thin bar directly under the prompt box, in a small monospace font, shown only when there are lines.
  - Basic SGR codes become styled spans: 16 and 256 colours, bold and dim. Other escape sequences are removed.
  - The bar updates from events, with no polling.
- **TUI:** the session footer (`packages/tui/src/routes/session/footer.tsx`) shows the lines in place of its fixed content while there are any, and shows the fixed content again when there are none. ANSI is rendered by the terminal.

## Error handling

- **Bad runs:** a non-zero exit, a timeout or empty output keeps the last good lines for up to 60 s, then clears them.
- **Logging:** errors are logged once per session per distinct error, not on every run.
- **Untrusted commands:** an untrusted Claude-sourced command is skipped, and the Hooks settings page shows it awaiting review.
- **Isolation:** a status line failure never affects a session or the server.

## Testing

All tests use real scripts and a real server, with no mocks. The clock is injectable.

1. **Input:** a configured script receives the Claude-format JSON with real values: model, cwd, cost and `context`.
2. **Throttling:** several rapid session changes cause at most one run per 300 ms window. An in-flight run makes the next one skip.
3. **Timeout:** the 5 s timeout kills a hanging script.
4. **Claude fallback:** it is used when no native config exists. A project `statusLine` needs trust, and the disable flags turn the fallback off.
5. **No config:** no runs happen.
6. **Failures:** a failing script keeps the last good lines, then clears them after 60 s.
7. **Delivery:** the event is published, and the route returns the last result and triggers a run when stale.
8. **App:** the ANSI-to-spans helper and the bar's visibility rule (browser suite).
9. **TUI:** a footer component test if the TUI package has a harness; otherwise a test of the pure line-formatting helper.

## Out of scope

- Claude's `statusLine` `type` values other than `command`.
- A status line in the run-mode footer (`flynncode run`).
