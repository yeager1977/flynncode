# Scriptable Status Line Design

Date: 2026-10-28
Status: implemented (7818c2dfa0, 6f6bbb56fb and the review fixes that followed); this document matches the code

## Problem

Claude Code's `statusLine` setting runs a user command with session JSON on stdin and shows its output at the bottom of the screen. Flynncode has nothing like it: the TUI session footer is hardcoded, and the desktop app has no status line.

This is part 4 of workstream 4 of the 2026-10-26 agent-parity plan. Parts 1–3 are done: Claude-compatible hooks, agent scheduling and worktree tools.

## Decisions

- **Shown in both the desktop app and the TUI**, driven by one config.
- **The server runs the command.** It runs per session, throttled, and publishes the result as an event. Clients only render it, so this also works for clients that cannot run commands, such as the browser app and remote servers.

## Design

### Config

`statusLine: { type: "command", command: string, padding?: number }` in Flynncode config. This is the same shape as Claude Code's. `ConfigV1.StatusLine` also has a `source` field: the loader sets it on a status line read from Claude settings, and strips it from native files, so a project file cannot pose as a Claude source.

When no native `statusLine` is set, Flynncode falls back to a `statusLine` found in Claude settings: `~/.claude/settings.json` and `settings.local.json`, then the project `.claude/settings.json` and `settings.local.json`, using the same directories the compat pack walks. The closest file wins.

- `OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_CLAUDE_HOOKS` turn the fallback off, as do `claude_hooks.disabled` and Claude's own `disableAllHooks`.

### Trust

Every status line command goes through the hook trust check (`HooksTrust`), exactly like a native hook, whichever layer it comes from: native user config, project config or Claude settings. A cloned repository's project config cannot run a command on session open.

- The trust identity is `HooksTrust.fromHandler("StatusLine", undefined, { type: "command", command }, source)`, bound per project. Binding hashes the project scripts the command names, so changing the command or editing such a script needs trust again.
- Managed (MDM) hooks and `--dangerously-bypass-hook-trust` count as trusted, as for hooks. A trust lookup failure reads as untrusted.
- An untrusted command is skipped. Its session's lines are cleared, the skip is logged once per session, and the session stays watched, so trusting it brings the line back.
- The Hooks settings page lists the command as "Status line" (event `StatusLine`) whenever `statusLine` is configured, awaiting review until trusted. Trusting or revoking it there re-runs every watched session at once.
- Flynncode's `hooks.disableAllHooks` kill switch also turns the status line off: it is treated as unconfigured.

### Input

The command gets Claude Code's status JSON on stdin.

| Field                                             | Value                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `hook_event_name`                                 | `"Status"`                                                                                             |
| `session_id`, `transcript_path`, `cwd`, `version` | From the session. `transcript_path` uses the Claude-format transcript writer from the hooks work.      |
| `model`                                           | `{ id, display_name }`                                                                                 |
| `workspace`                                       | `{ current_dir, project_dir }`                                                                         |
| `output_style`                                    | `{ name }`, set to the current agent's name (by design; Flynncode has no output styles)                |
| `cost`                                            | `{ total_cost_usd, total_duration_ms, total_api_duration_ms, total_lines_added, total_lines_removed }` |
| `exceeds_200k_tokens`                             | Boolean                                                                                                |
| `context`                                         | Flynncode extra: `{ used_tokens, limit }`                                                              |

Values that approximate Claude's meaning:

- `total_duration_ms`: wall time since this server process first served the session's status line (its first GET). Claude counts the wall time of its own process's session, so both reset on a restart. Counting from session creation would read as days for a reopened session.
- `total_api_duration_ms`: model time only. For each finished assistant message, its duration minus the span from its first tool start to its last tool end (parallel tools overlap, so the span, not the sum). Text the model streams while tools run is not counted.
- `exceeds_200k_tokens`: the input plus cache (read and write) tokens of the last request, which is the newest assistant message that reported tokens. Output and reasoning tokens do not count.
- `context.used_tokens`: that message's total tokens, the same number as the app's context meter. `context.limit` is `null` when the catalog has no entry.
- `model.id` is the bare model ID, `""` when the session has no model yet.

**Environment:** the command runs in the session's working directory with the same environment policy as the hooks executor: the server's environment plus `CLAUDE_PROJECT_DIR`.

### When it runs

- **What triggers a run:** a change to the session's messages, model, agent, folder or status, for a watched session. Runs are throttled to at most one per 300 ms per session, measured from the start of the last run.
- **Trailing run:** the throttle is trailing-edge. A change inside the window waits for its end, and a change during a run waits for that run, so runs never overlap and the latest change always gets one run after the one in flight. Changes in between collapse into it.
- **Timeout:** a run is killed after 5 s, with its whole process group (`sh -c` is spawned detached). stdout and stderr are each read up to 64 KiB.
- **Concurrency:** at most 2 commands run at once per process, across all sessions. A run waiting for its turn counts as running for its session.
- **No config, no work:** with no status line configured, nothing runs and nothing subscribes. The bus listener exists only while a session is watched.

### Watching

A session is watched only when a client explicitly views it: a `GET /session/{id}/statusline` starts the watch and renews it. Nothing else does; the TUI's sub-agent cards never ask.

- **On GET:** a run starts when none is pending and the last one started more than `STALE_MS` = 10 s ago, or never.
- **Expiry:** a watch that no GET has renewed for 5 minutes ends at its next trigger if the session is idle then. A session that is working keeps running, so a long turn still updates the line.
- **Cap:** at most 8 watched sessions per process. A new one evicts the least recently requested.
- **Clients re-GET** when the session opens or changes, when the event stream reconnects (watches live only in server memory, so a restarted server or sidecar knows nothing until asked), and when the viewed session's status changes. The status rule keeps a session that was left open and idle for more than 5 minutes updating when a turn starts. Clients never poll.

### Output and delivery

- **Sanitizing:** the server keeps only printable text and SGR sequences. It strips every other CSI (cursor movement and the like), OSC (titles, clipboard writes, hyperlinks), DCS, SOS, PM and APC strings, other escapes, all C0 controls (tab and carriage return included), DEL, C1 controls (U+0080–U+009F, including the 8-bit CSI U+009B and OSC U+009D), and the bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069).
- **Lines:** the first 2 lines with visible text after sanitizing, each capped at 200 visible characters. SGR sequences do not count toward the cap and are never cut in half.
- **Padding:** `padding` is applied on the server, after sanitizing, as that many leading spaces. It sits outside the 200-character cap. Clients render lines verbatim (`white-space: pre` in the app, `wrapMode="none"` in the TUI).
- **Event:** the server publishes `session.statusline { sessionID, lines }` and keeps the last result per session.
- **Route:** `GET /session/{id}/statusline` returns the last result `{ lines, updatedAt }` (`updatedAt` is the last run that produced lines) and starts or renews the watch; see Watching.
- **Clearing:** when the config is removed, the kill switch is set or the command becomes untrusted, watched sessions get `session.statusline` with empty `lines`, from the next run or GET.
- **SDK:** `client.session.statusline.get`.

### Display

Both clients parse lines with the shared `parseAnsi` helper (`packages/ui/src/theme/ansi.ts`), which sanitizes again with the server's rules (defence in depth) and then reads SGR:

- foreground 30–37, 90–97, `38;5;n`, `38;2;r;g;b` and 39; background 40–47, 100–107, `48;5;n`, `48;2;r;g;b` and 49; the `:` sub-parameter forms of 38 and 48;
- bold (1), dim (2) and their reset (22); 0 resets everything;
- `58` (underline colour) and its operands are consumed and ignored, and other codes (3, 4, 7, 23, 24 and so on) are ignored, so an operand is never read as a code.

- **Desktop app:** a thin bar directly under the prompt box, in a small monospace font, shown only when there are lines. Runs become spans with foreground and background colours; the 16 base colours follow theme tokens. The GET result applies unless an event or a session switch came after the request started.
- **TUI:** `SessionStatusLine` (`packages/tui/src/routes/session/status-line.tsx`), mounted by the main session view directly below the prompt, shows the lines while there are any. opentui does not interpret raw ANSI, so each run becomes a styled span with RGBA foreground and background; colours 0–15 come from the TUI's fixed ANSI table. The session footer (`footer.tsx`) is not mounted in the TUI and is unchanged. The component keeps the GET result and events with the same generation guard as the app.

## Error handling

- **Bad runs:** a non-zero exit, a timeout or empty output keeps the last good lines for up to 60 s, then clears them.
- **Logging:** errors are logged once per session per distinct error, not on every run.
- **Untrusted commands:** an untrusted command, from any config, is skipped and its lines cleared, and the Hooks settings page shows it as "Status line" awaiting review.
- **Isolation:** a status line failure never affects a session or the server.

## Testing

All tests use real scripts and a real server, with no mocks. The clock is injectable.

1. **Input:** a configured script receives the Claude-format JSON with real values: model, cwd, cost, model-only API time, `context`, and `exceeds_200k_tokens` from input and cache tokens.
2. **Throttling:** several rapid session changes cause at most one run per 300 ms window. Changes during an in-flight run wait for it and get one trailing run.
3. **Timeout:** the 5 s timeout kills a hanging script and its children.
4. **Claude fallback:** it is used when no native config exists, and the disable flags turn it off.
5. **Trust:** an untrusted native or Claude command is skipped and listed on the Hooks page; trusted, it runs; a changed command needs trust again. `hooks.disableAllHooks` turns it off and clears the lines.
6. **No config:** no runs happen and nothing subscribes.
7. **Failures:** a failing script keeps the last good lines, then clears them after 60 s.
8. **Delivery:** the event is published, and the route returns the last result and triggers a run when stale.
9. **Watching:** an unrenewed watch keeps running while its session works and ends once it is idle; at most 8 sessions are watched, evicting the least recently requested; at most 2 commands run at once.
10. **Sanitizing:** non-SGR escapes, C0 and C1 controls and bidi controls are stripped, and the cap counts visible characters only.
11. **App:** `parseAnsi` (backgrounds, extended colours, resets, a powerline-style line, sanitizing), the colour mapping, the bar's visibility rule and the fetch/event guard (browser suite).
12. **TUI:** the chunk helper (foreground, background, attributes, sanitizing), the rows component and the fetch/event guard.

## Out of scope

- Claude's `statusLine` `type` values other than `command`.
- A status line in the run-mode footer (`flynncode run`).
