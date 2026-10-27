# Agent Scheduling Design

Date: 2026-10-27
Status: implemented on dev (2026-10-27); this spec is synced with the implementation, including the final-review fixes

## Problem

The Flynncode agent cannot schedule anything. Claude Code's agent can:
- schedule recurring or one-shot prompts back into its own session (CronCreate, CronList, CronDelete);
- pace itself with ScheduleWakeup;
- run `/loop` to repeat a task on an interval or on its own schedule.

Flynncode's existing Routines plugin (`packages/flynncode/src/plugin/routines`) is configured by the user in settings, and every run creates a new session. Nothing re-prompts an existing session.

This is part 2 of workstream 4 of the 2026-10-26 agent-parity plan. The parts are: Claude-compatible hooks (done), agent scheduling (this spec), worktree tools, and the status line.

## Decisions

- **Jobs survive restarts.** They are stored in the history database and tied to their session. A restart picks them up again. A run missed while the app was closed runs once, not once per missed slot.
- **New scheduler service.** It uses a database table, a 15-second tick, and a lease, so only one server fires a job. Prompts are delivered through the existing queued synthetic-prompt path. Routines is not extended.

## Design

### Tools

**`cron_create { cron: string, prompt: string, recurring?: boolean }`**
- `cron` is standard 5-field cron in the server's local time zone.
- `recurring` defaults to `true`. `false` fires once, at the next match.
- It returns the job id and the next run time.
- A recurring job expires 7 days after creation. A recurring cron whose first match is at or after that expiry (for example `0 0 1 1 *` in October) is refused with a clear error, because it would never fire; a one-shot has no expiry.
- The minimum interval is 1 minute, which 5-field cron enforces by construction.

**`cron_list {}`** lists the session's jobs: id, kind, cron, prompt, next run, recurring, expiry.

**`cron_delete { id: string }`** cancels one of the session's jobs. An unknown id returns "no such job".

**`schedule_wakeup { delaySeconds: number, prompt: string, reason: string }`**
- It fires once, `delaySeconds` from now, clamped to [60, 3600].
- A session has at most one pending wakeup; a new call replaces it.
- `reason` is shown to the user.

**Limits:**
- 20 active jobs per session; a wakeup counts as one.
- The tools are available in root sessions only, because a finished sub-agent must never be woken. A sub-agent session's model requests do not carry the four tools at all (which also saves their tokens); a direct call from a sub-agent still returns a clear error.
- The four descriptions are kept short (about 1 KB together), since root sessions send them on every request.

**Permissions:**
- The four tools share one `schedule` permission key, allowed by default and configurable like any key. A deny hides all four.
- Claude Code's `CronCreate`, `CronList`, `CronDelete` and `ScheduleWakeup` names all map to that one key, so a Claude rule for one of them applies to all four. This is deliberate: one key keeps the permission model simple while `schedule` defaults to allow.
- Claude-format hooks see the Claude tool names. Their `tool_input` keys are snake_case like other translated tools, except `ScheduleWakeup`, which keeps Claude Code's camelCase `delaySeconds`.
- Turns started by a scheduled prompt ask for tool permissions as usual.

### Storage

New table `session_schedule`, with snake_case columns:

| Column | Meaning |
|---|---|
| `id` | Job id. |
| `session_id` | The session the job belongs to. |
| `kind` | `cron` or `wakeup`. |
| `cron` | The cron expression; null for wakeups. |
| `prompt` | The prompt to deliver. |
| `reason` | Wakeup reason; null for cron jobs. |
| `recurring` | Boolean. |
| `next_run_at` | When the job next fires. |
| `expires_at` | Recurring jobs: creation + 7 days. Otherwise null. |
| `lease_until` | End of the current claim; null when unclaimed. |
| `failures` | Consecutive delivery failures. |
| `pending_message_id` | The message id of the last delivered prompt, used for overlap skipping. |
| `time_created` | Creation time. |
| `owner` | The kind of server process that created the job and delivers it: `sidecar`, `tui` or `serve`. Defaults to `sidecar`. |

- The table is local to this machine and is not synced to the hub.
- Database migrations add it (`20261027210409_session_schedule`) and its `owner` column (`20261027231709_session_schedule_owner`, additive with a default, so jobs from before it belong to the sidecar). There is no foreign key to `session`, because machine sync deletes and re-inserts session rows; session delete and archive remove a session's jobs, and the tick prunes orphans.

### Firing

- **Who fires.** Every long-lived server process opts in with `Scheduler.enableLeadership(kind)`:
  - the desktop sidecar as `sidecar`;
  - the TUI worker as `tui`;
  - `serve`, `web` and `acp` as `serve` (they all serve through `Server.listen`; keeping them one kind avoids a fourth leader for rare cases).
  - `flynncode run`, plugin clients and tests never opt in, so a short-lived process never claims a job and exits mid-turn. Jobs such a process creates belong to the sidecar.
- **One leader per kind.** Each kind has its own leader lock per database file (`Flock` key `scheduler-<kind>:<database path>`). A leader claims and delivers only jobs whose `owner` is its kind, so a scheduled turn runs, streams and asks for permissions in the kind of process whose clients created it. A job whose kind has no running process waits; its missed run fires once when one starts. A crashed leader's lock goes stale after 60 s.
- **Tick.** The leader ticks every 15 seconds. An idle tick is one read of its kind's jobs. It deletes expired jobs, prunes orphans at most once a minute, then, for each due job, warms the session's instance and claims the job atomically (`next_run_at <= now`, lease empty or expired) by setting `lease_until = now + 60s`. Only jobs whose claim succeeded are delivered, and `complete`/`skip`/`fail` are fenced on the claimed lease.
- **Deferral.** A job whose session has a pending revert is not claimed: admitting a prompt would commit the revert. It fires once the revert is resolved.
- **Never into a busy session.** A prompt admitted into a running turn would steer it, so nothing is delivered while the session is busy:
  - a recurring job moves to its next slot without delivering;
  - a one-shot job or wakeup stays due (its lease released) and fires on a later tick once the session is idle.
  - Busy means: this process's run state says so (exact for turns it drives, including turns the scheduler itself just started), or, for a turn another process drives, the session's **latest** assistant message is unfinished and it, its parts, or a sub-agent session created after it was written within the last 10 minutes. An unfinished assistant row followed by a newer assistant message is a crash orphan and never counts; a newer user message does not end a turn, because prompts are queued into running turns. After a crash the session looks busy for at most 10 minutes, which only delays jobs.
- **Delivery** into an idle session admits the prompt as a synthetic text prompt with `queue` delivery and no reply, then starts the turn (forked, so it never holds up the tick).
  - The turn uses the session's current agent, model and variant.
  - Scheduled prompts are synthetic, so `UserPromptSubmit` hooks do not run for them.
  - A prompt that starts with `/name args`, where `name` is a known command, runs that command at fire time through the session's command path (`SessionPrompt.command` with internal scheduled metadata): the expanded text parts are synthetic and carry the schedule metadata, the prompt is queued without a reply, and `!` shell lines in the template are left as text (nobody is there to approve them; the model can run them with its tools, which ask as usual). Any other text, including an unknown `/word`, is delivered as is.
- **Overlap:** if the job's previously delivered prompt has not been promoted yet (no newer assistant message answers it or a later prompt), the firing is skipped and the job moves to its next slot. In an idle session such a prompt was stranded by a process that exited before answering it, so the scheduler starts a turn that answers it.
- **After delivery:**
  - a recurring job's `next_run_at` moves to the next cron match after now;
  - a one-shot job or wakeup is deleted;
  - the lease and failure count are cleared.
- **Missed runs:** a recurring job whose `next_run_at` is in the past fires once, then moves to the next match after now. A missed one-shot job or wakeup fires once.
- **Transcript:** the prompt shows below a compact divider, "⏰ Scheduled · `<cron>`" or "⏰ Wakeup · `<reason>`". The divider data travels in the synthetic part's metadata (`schedule: { id, kind, cron?, reason? }`).

### `/loop`

`/loop` is a built-in command. Native and Claude `loop` commands from config override it; `loop` is the only built-in a Claude command may replace. Its instructions are computed from the arguments by `Command.Info.expand` (internal, off the public schema), so the arguments are not substituted or appended again and `!` shell lines in them are never run.

| Form | What the agent is told |
|---|---|
| `/loop <interval> <prompt>` | Run the prompt now, then call `cron_create` with the equivalent cron. Intervals: `Nm`, `Nh`, `Nd`; seconds are rounded up to 1 minute. Intervals that don't divide evenly round to the nearest supported cron and say so. Multi-day steps (`*/N` day of month) restart on the 1st of each month, which the agent is told. An interval of 7 days or more is refused, because the recurring job would expire before its second run. |
| `/loop <interval> /command args` | The command can only run when a scheduled prompt fires, so: `cron_create` with the command as the prompt, plus `schedule_wakeup(60)` with the same command for the first run. |
| `/loop <prompt>` | Do the work now. If more work remains, call `schedule_wakeup` with the prompt `/loop <prompt>` exactly and a delay chosen from how quickly things change. The woken turn re-runs `/loop`, so it gets these rules again instead of relying on history that compaction may summarize. When the work is finished, don't schedule another. |
| `/loop /command` | Refused: a self-paced loop cannot run a slash command. The agent suggests an interval. |
| `/loop stop` | Delete this session's jobs and wakeup with `cron_list` / `cron_delete`. |

### Lifetime

- A session's jobs are deleted when the session is deleted or archived, including by retention cleanup.
- Recurring jobs past `expires_at` are deleted on the next tick.
- A job whose session no longer exists, or that has failed delivery 3 times in a row, is deleted and logged.

### App and API

**Session header chip:** "⏰ N scheduled" while the session has active jobs. Clicking it opens a "Scheduled" section in the session side panel, which is shared with tasks and background shells. Each job shows:
- its kind;
- its cron, or the wakeup time and reason;
- its prompt and next run;
- a **Cancel** button.

**Routes:**
- `GET /session/{id}/schedules`
- `DELETE /session/{id}/schedules/{jobId}`

**Event:** `session.schedule.updated { sessionID }`, published on create, fire, delete and expiry. The app re-lists when it arrives; nothing polls.

**SDK:** `client.session.schedules.list` and `.delete` in the legacy v2 SDK. The Protocol-based `packages/client` has no schedules routes, like background shells; this gap is tracked with the shells gap.

## Error handling

- **Invalid input:** an invalid cron, going over the job limit, or a call from a sub-agent session returns a clear tool error; nothing is stored.
- **Delivery failures:** a failure is logged and retried on the next tick. After 3 consecutive failures the job is deleted.
- **Scheduler failures:** a failing tick is logged and never affects sessions or the server.
- **Server stop:** in-flight leases expire, so another server, or the next start, picks the jobs up.

## Testing

All tests are in `packages/flynncode`, against the real database and the test LLM server, with no mocks. The clock is injectable.

1. **Firing:** `cron_create` stores the job and the next run. A due job fires into an idle session, producing one model request. Nothing is admitted while a turn runs (in this process or another): a recurring job moves on, a one-shot stays due and fires once the session is idle. An old unfinished assistant row followed by a completed turn does not hold delivery.
2. **Wakeups:** `schedule_wakeup` clamps to [60, 3600], and a second call replaces the first.
3. **Restarts:** jobs survive a scheduler restart. A missed recurring job fires once and advances. A missed one-shot fires once and is deleted.
4. **Overlap:** a firing is skipped while the earlier prompt is still pending.
5. **Expiry:** a recurring job is deleted after 7 days, using the injected clock.
6. **Session removal:** deleting or archiving a session deletes its jobs.
7. **Limits:** the 21st job is refused, and a sub-agent session is refused.
8. **Two schedulers:** two schedulers of the same kind on one database fire a due job exactly once; schedulers of two kinds each deliver only their own kind's jobs.
9. **Hooks:** `UserPromptSubmit` hooks do not run for scheduled prompts.
10. **`/loop`:** each form expands to the right instructions, and a config `loop` command overrides it. A scheduled `/command` prompt is expanded at fire time, and a self-paced wakeup re-runs `/loop`.
12. **Sub-agents:** a child session's model request carries none of the four tools.
11. **App:** the chip and panel helpers and the cancel request (browser suite).

## Out of scope

- Changes to Routines.
- Syncing schedules across machines.
- Jitter and per-job time zones.
- Worktree tools and the status line (own specs).
