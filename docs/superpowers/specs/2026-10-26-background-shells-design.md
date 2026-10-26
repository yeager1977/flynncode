# Background Shells Design

Date: 2026-10-26
Status: implemented (spec synced with the implementation on 2026-10-26)

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
  - when the session is a sub-agent's (it has a parent) and its run ends;
  - when the Flynncode server stops, or its process exits or receives SIGINT/SIGTERM;
  - when its time cap is reached. The default and maximum is 2 hours; the cap can be lowered with the config key `background_shells.max_ms`.
- At most 8 running background shells per session.

## Design

### Tools

**`bash` gains `run_in_background: boolean`.**
- When true, the command is started under a dedicated service, `BackgroundShells` (`packages/flynncode/src/shell/background`). It is separate from the existing background-job service, so pressing Stop on a session does not cancel its background shells.
- The call returns immediately with:
  - a shell id (`bash_<id>`);
  - the PID;
  - the output file path.
- The process runs in its own process group (`detached: true`). Stdout and stderr stream to an output file under `Global.Path.data/tool-output/`.
- `timeout` is the shell's time cap. It defaults to 2 hours and is clamped to `background_shells.max_ms` (config; itself at most 2 hours). The key is `background_shells.max_ms` because `shell` is already a string in the config (the default shell). The cap is read from the calling instance's config and passed to the service.
- Interactive commands (`interactive: true`, `sudo` without `-n`, `ssh -t`, `su`, `passwd`) cannot run in the background; the call is refused with a message.

**`bash_output { id, filter? }`**
- Returns the output produced since the previous read of that shell, plus its status: `running`, `exited` (with exit code), `killed` or `timed_out`. A shell stays `running` until its whole process group has exited, not only the leader.
- Reads use the output writer's logical stream (a 1 MiB window); a reader that falls behind skips ahead and the result reports `truncated: true`. Reads never touch the file on disk.
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

**Sub-agents.** A background shell started (or moved to the background) in a child session — a sub-agent's session, which has a parent — is killed when that session's run ends, i.e. when its `session.status` turns `idle`. Nobody watches the shell after the sub-agent has answered, and its exit notification would wake the finished sub-agent. The kill is explicit, so no notification is sent. The shell tool looks up the session's parent through the Session service and passes `child` to the service; root sessions keep the normal lifetime.

**Promote.** A running foreground `bash` call can be moved to the background without restarting it. A foreground `bash` call spawns its process into a scope it owns; promotion hands the live process to the service (`BackgroundShells.adopt`), which takes over the group, keeps the output printed so far readable through `bash_output`, and counts the time cap from the real start. The foreground call returns at once with the new shell id. Promotion is refused (409) at the session's limit of 8 running shells, and fails (404) when no such call is running. Interactive commands and calls without a call id cannot be promoted.

**Permissions.**
- `run_in_background` uses exactly the `bash` permission key and command-pattern rules.
- `bash_output`, `kill_shell` and `monitor` act only on shells of the same session and need no extra permission.

**Config.** `background_shells.max_ms` (positive integer, milliseconds) lowers the time cap; the maximum is 2 hours.

**Limits.**
- 8 running background shells per session; a 9th is refused with a clear message.
- 4 active monitors per session.

### Notifications

Notifications are delivered to the session the same way a background sub-agent's completion is delivered: a synthetic text prompt through the tool call's `promptOps`, using `queue` delivery. A notification that arrives mid-turn waits for the turn to end instead of interrupting it. A failure to notify never affects the shell.

They reuse the existing compact "Background activity" divider for synthetic messages in the transcript; no new styling was added.

### App

**Indicator.** While a session has running background shells, the session header shows a chip, e.g. "⚙ 2 running". The sidebar badge was not built: the sync store holds no per-session shell data, and adding it only for a badge was not worth a second source of truth.

**Panel.** Clicking the chip opens a "Background shells" section in the session side panel (shared with tasks). For each shell it shows:
- the command, the elapsed time and the state;
- a live tail of the last 200 lines;
- a **Stop** button (the same kill as `kill_shell`) and, in the desktop app against a local server, **Open full output**.

**Promote button.** A foreground shell running for more than 10 seconds shows a **Move to background** button on its tool card (not for interactive commands). This mirrors Claude Code's Ctrl+B. It calls the promote route; failures show an error toast.

**Transcript.** A background `bash` call renders as a compact card, e.g. "started in background: `bun dev` · bash_3f2a".

**Events.** State reaches the app through new events on the v1 global event stream: `shell.background.started { sessionID, id, command, pid, startedAt }`, `shell.background.output { sessionID, id, bytes, tail }` (at most one per second per shell; `tail` is the last 4 KiB) and `shell.background.exited { sessionID, id, status, exitCode? }`. Output that arrives inside the one-second window schedules a single trailing output event at the end of the window, so the last lines before a quiet spell still reach the app; output not yet announced when a shell finishes goes out (still throttled) just before its exit event. Nothing polls; the app lists shells once when a session opens and then follows events. Only `started` and `exited` events make an in-flight list response stale; output events do not, so a busy shell cannot keep the list from landing.

**Routes** (all under the session, with the usual workspace routing):
- `GET /session/{id}/shells` lists the session's shells, running and recently finished.
- `GET /session/{id}/shells/{shellId}/output?offset=` reads from a logical stream offset (default 0) and returns the next offset. It does not move the agent's own read position.
- `POST /session/{id}/shells/{shellId}/stop` kills the group and returns the shell; an already finished shell is returned unchanged.
- `POST /session/{id}/shells/promote { callID }` moves a running foreground call to the background (404 / 409 as above).

**SDK.** `client.session.shells.list`, `.output`, `.stop` and `.promote` (v2 SDK).

## Error handling

**Never orphaned.**
- Each background shell's process-group id is registered with its session and recorded in the registry under `Global.Path.state/background-shells/`: one file per server process, named `<pid>-<starttime>.json`. Several servers (desktop sidecar, CLI/TUI, dev servers) share that directory, so a server only writes its own file; the start time in the name makes a recycled server pid a different owner.
- A server-stop finalizer kills every registered group.
- A synchronous process `exit` hook sends SIGTERM to the group of every running shell, for exits that skip finalizers (`process.exit`, a forced quit). `flynncode serve` handles SIGINT/SIGTERM by stopping the server normally (so the finalizer runs) and then exiting; a second signal forces the exit, which still runs the hook. Without a handler Node would end the process on these signals without running even the `exit` hook.
- The desktop sidecar's `stop()` disposes instances and then closes the listener, whose finalizer kills the shells. The server bundle exposes no handle to the service, so the shells cannot be killed before instance disposal; the `exit` hook covers anything left when the sidecar calls `process.exit`.
- Each group is recorded by its id (the leader's pid, since it is spawned detached) and its leader's start time (`/proc/<pid>/stat` field 22), read the moment it is spawned. If the leader has already exited by then, the earliest surviving member's start time is used. Command lines are not used: a dev server started with `cmd >log 2>&1 &` has a leader that exits at once while the server lives on. Without `/proc` nothing is recorded.
- On startup, files of dead owners are read and their groups are killed only if they are still the same group: either the leader is running with the recorded start time, or the leader is gone but processes in that group started no earlier than it exist (leaderless groups are reaped as a whole). A leader pid with a different start time and no matching members was recycled and is skipped. Without `/proc` nothing can be verified, so nothing is killed.
- A shell keeps being tracked until every member of its group has exited, so a daemon that outlives the leader is still killed by `kill_shell`, the cap, session deletion or server stop. Processes that leave the group (`setsid`) are not tracked.
- Finished shells are kept for listing (50 per session, 200 overall) and then dropped.

**Output safety.** Output files live under `Global.Path.data/tool-output/` (`tool_<id>`) and are covered by the existing 7-day retention. The service caps each file at 8 MiB (the writer's own default is 50 MiB): the first 1 MiB (head) stays in the file and only a rolling tail (about 7 MiB, held in memory per running shell) follows it. Reads report `truncated: true` once the cap is hit. Filtered reads stop at the last complete line so a match split across chunks is not lost. When a shell finishes, its read window is trimmed to the newest 64 KiB (enough for the exit summary and late reads); a read from an older offset reports the dropped bytes as skipped.

**Unknown ids.**
- `bash_output`, `kill_shell` and `monitor` on an unknown id return "no such background shell" instead of throwing.
- Killing a shell that has already exited returns its final status.

**Monitor patterns.** The regex is validated before a monitor starts; an invalid pattern is rejected. A monitor that times out reports "pattern not seen". Monitors act on the shells of their own session only.

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
6. Deleting the session, stopping the server, the process exit hook and the end of a sub-agent's run each leave no processes behind; a root session's shell survives its session going idle.
7. Recorded leftovers are killed on startup only when the recorded (group id, leader start time) identity still matches, including groups whose leader is gone; recycled pids are skipped.
8. The output cap keeps the head plus a rolling tail.
9. A command pattern denied for `bash` is also denied with `run_in_background`.
10. App: the chip and panel helpers render running shells and send stop requests (browser suite).
11. HTTP routes (list, output, stop, promote — including a real promotion, 409 at the shell limit and 404 for an unknown call) and CORS for the new methods.
12. Promote: a foreground command moved to the background keeps running, its earlier output is readable, and abort, timeout and limit paths leave no process behind (aborting the original call after promotion does not kill the shell; its cap still does).
13. Events: a throttled chunk followed by silence arrives in a trailing output event within the window.
14. `flynncode serve` turns SIGINT/SIGTERM into a normal shutdown.

## Out of scope

- Claude compatibility pack, deferred MCP tools, and hooks/scheduling/worktree tools (own specs).
- Shells that survive server restarts.
- Interactive input to background shells.
