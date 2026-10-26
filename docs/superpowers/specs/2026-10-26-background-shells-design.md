# Background Shells Design

Date: 2026-10-26
Status: approved design, pending implementation plan

## Problem

Flynncode's `bash` tool always blocks until the command finishes. The agent
cannot start a dev server, a long build or a test watcher and keep working,
cannot read that process's output later, and cannot stop it. Claude Code's
agent can do all of this (`run_in_background`, BashOutput, KillShell, Monitor).
This is the first of four agent-parity workstreams chosen on 2026-10-26:

1. background shells (this spec);
2. Claude compatibility pack;
3. deferred MCP tools;
4. hooks, scheduling and worktree tools.

Orphaned background processes have hurt this machine before. A stray 2.9 GB
`bun test` watcher caused swap-thrash freezes. Lifetime control is therefore a
first-class requirement.

## Decisions

- Match Claude Code's tool names and semantics where they exist.
- Every background shell belongs to its session and is stopped automatically:
  - when the session is deleted or archived;
  - when the Flynncode server stops;
  - when its time cap is reached. The default and maximum is 2 hours, configurable.
- At most 8 running background shells per session.

## Design

### Tools

**`bash` gains `run_in_background: boolean`.**
- When true, the command is started under the existing background-job service (`packages/core/src/background-job.ts`).
- The call returns immediately with:
  - a shell id (`bash_<id>`);
  - the PID;
  - the output file path.
- The process runs in its own process group (`detached: true`). Stdout and stderr stream to an output file under `Global.Path.data/tool-output/`.
- `timeout` is the shell's time cap. It defaults to `shell.backgroundMaxMs`, which defaults to 2 hours, and it is clamped to that value.

**`bash_output { id, filter? }`**
- Returns the output produced since the previous read of that shell, plus its status: `running`, `exited` (with exit code), `killed` or `timed_out`.
- `filter` is a regex: only matching lines are returned. The read position still advances past every line.

**`kill_shell { id }`**
- Sends SIGTERM to the whole process group, then SIGKILL after 5 seconds if anything is still alive.
- Returns the final status.

**`monitor { id, pattern, timeout? }`**
- Watches a running background shell's output.
- It notifies the session in three cases:
  - a new line matches `pattern`;
  - the shell exits;
  - the deadline passes (default 10 minutes, maximum 30).
- The monitor ends after its first notification.

**Exit notification.** When a background shell exits on its own, or hits its cap, the session gets a short notification:
- the shell id and command;
- the exit status;
- the last 20 lines of output.

**Promote.** A running foreground `bash` call can be moved to the background through the existing promote mechanism. It then becomes a background shell with an id.

**Permissions.**
- `run_in_background` uses exactly the `bash` permission key and command-pattern rules.
- `bash_output`, `kill_shell` and `monitor` act only on shells of the same session and need no extra permission.

**Limits.**
- 8 running background shells per session; a 9th is refused with a clear message.
- 4 active monitors per session.

### Notifications

Notifications are delivered to the session the same way a background sub-agent's completion is delivered, using `queue` delivery. A notification that arrives mid-turn waits for the turn to end instead of interrupting it.

They render as compact system lines in the transcript, not as full user messages.

### App

**Indicator.** While a session has running background shells:
- the session header shows a chip, e.g. "⚙ 2 running";
- the sidebar row shows a small badge.

**Panel.** Clicking the chip opens a "Background shells" panel. For each shell it shows:
- the command, the elapsed time and the state;
- a live tail of the last 200 lines;
- a **Stop** button (the same kill as `kill_shell`) and **Open full output**.

**Promote button.** A foreground shell running for more than 10 seconds shows a **Move to background** button on its tool card. This mirrors Claude Code's Ctrl+B.

**Transcript.** A background `bash` call renders as a compact card, e.g. "started in background: `bun dev` · bash_3f2a".

**Events.** State reaches the app through new session events: `shell.background.started`, `.output` (throttled ticks) and `.exited`. One route reads output and one stops a shell; nothing polls.

## Error handling

**Never orphaned.**
- Each background shell's process-group id is registered with its session and recorded in a small registry file under the data dir.
- A server-stop finalizer kills every registered group.
- On startup, recorded groups left by a crash are killed only if the process's command line still matches the recorded one. This prevents killing an unrelated process that reused the PID.

**Output safety.** Output files live under `tool-output/` and are covered by the existing 7-day retention. Each file is capped at 50 MB: past the cap, the head is kept and only a rolling tail is stored.

**Unknown ids.**
- `bash_output`, `kill_shell` and `monitor` on an unknown id return "no such background shell" instead of throwing.
- Killing a shell that has already exited returns its final status.

**Monitor patterns.** The regex is validated before a monitor starts; an invalid pattern is rejected. A monitor that times out reports "pattern not seen".

**Failures stay local.** A failure in the notification or event path never kills the shell or the session.

## Testing

All tests live in `packages/flynncode`, use real processes and use no mocks.

1. A background `sleep 0.2; echo done` returns at once with an id. After it exits, `bash_output` shows `done` and exit code 0, and the session received an exit notification.
2. A shell that spawns children (`sh -c 'sleep 60 & sleep 60'`): `kill_shell` leaves no surviving process in the group.
3. The time cap kills the shell and reports `timed_out`.
4. `monitor`:
   - wakes on a matching line;
   - times out when nothing matches;
   - rejects an invalid regex.
5. A 9th concurrent shell is refused.
6. Deleting the session and stopping the server each leave no processes behind.
7. Recorded leftovers are killed on startup only when the command line matches.
8. The output cap keeps the head plus a rolling tail.
9. A command pattern denied for `bash` is also denied with `run_in_background`.
10. App: the chip and panel helpers render running shells and send stop requests (browser suite).

## Out of scope

- Claude compatibility pack, deferred MCP tools, and hooks/scheduling/worktree tools (own specs).
- Shells that survive server restarts.
- Interactive input to background shells.
