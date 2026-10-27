# Agent Scheduling Design

Date: 2026-10-27
Status: approved design, pending implementation plan

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
- A recurring job expires 7 days after creation.
- The minimum interval is 1 minute, which 5-field cron enforces by construction.

**`cron_list {}`** lists the session's jobs: id, kind, cron, prompt, next run, recurring, expiry.

**`cron_delete { id: string }`** cancels one of the session's jobs. An unknown id returns "no such job".

**`schedule_wakeup { delaySeconds: number, prompt: string, reason: string }`**
- It fires once, `delaySeconds` from now, clamped to [60, 3600].
- A session has at most one pending wakeup; a new call replaces it.
- `reason` is shown to the user.

**Limits:**
- 20 active jobs per session; a wakeup counts as one.
- The tools are available in root sessions only. In a sub-agent session (one with a parent) they return a clear error, because a finished sub-agent must never be woken.

**Permissions:**
- The four tools use a new `schedule` permission key, allowed by default and configurable like any key.
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

- The table is local to this machine and is not synced to the hub.
- A database migration adds it.

### Firing

- Every 15 seconds, the scheduler atomically claims due jobs (`next_run_at <= now`, lease empty or expired) by setting `lease_until = now + 60s`. Only jobs whose claim succeeded are delivered. This makes several servers on one database (desktop sidecar, CLI, dev servers) fire each job once.
- **Delivery** admits the prompt to its session as a synthetic text prompt with `queue` delivery, the path background-shell notifications use (`packages/flynncode/src/tool/shell/background.ts:15-42`). An idle session starts a turn; a busy session gets it after the current turn ends.
  - The turn uses the session's current agent and model.
  - Scheduled prompts are synthetic, so `UserPromptSubmit` hooks do not run for them.
- **Overlap:** if the job's previously delivered prompt has not been promoted yet, the firing is skipped and the job moves to its next slot.
- **After delivery:**
  - a recurring job's `next_run_at` moves to the next cron match after now;
  - a one-shot job or wakeup is deleted;
  - the lease and failure count are cleared.
- **Missed runs:** a recurring job whose `next_run_at` is in the past fires once, then moves to the next match after now. A missed one-shot job or wakeup fires once.
- **Transcript:** the prompt shows below a compact divider, "⏰ Scheduled · `<cron>`" or "⏰ Wakeup · `<reason>`". The divider data travels in the synthetic part's metadata (`schedule: { id, kind, cron?, reason? }`).

### `/loop`

`/loop` is a built-in command. Native and Claude `loop` commands from config override it.

| Form | What the agent is told |
|---|---|
| `/loop <interval> <prompt>` | Run the prompt now, then call `cron_create` with the equivalent cron. Intervals: `Nm`, `Nh`, `Nd`; seconds are rounded up to 1 minute. Intervals that don't divide evenly round to the nearest supported cron and say so. |
| `/loop <prompt>` | Do the work now. If more work remains, call `schedule_wakeup` with a delay chosen from how quickly things change. When the work is finished, don't schedule another. |
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

**SDK:** `client.session.schedules.list` and `.delete` in the v2 SDK.

## Error handling

- **Invalid input:** an invalid cron, going over the job limit, or a call from a sub-agent session returns a clear tool error; nothing is stored.
- **Delivery failures:** a failure is logged and retried on the next tick. After 3 consecutive failures the job is deleted.
- **Scheduler failures:** a failing tick is logged and never affects sessions or the server.
- **Server stop:** in-flight leases expire, so another server, or the next start, picks the jobs up.

## Testing

All tests are in `packages/flynncode`, against the real database and the test LLM server, with no mocks. The clock is injectable.

1. **Firing:** `cron_create` stores the job and the next run. A due job fires into an idle session, producing one model request. A job that fires into a busy session waits for the turn to end.
2. **Wakeups:** `schedule_wakeup` clamps to [60, 3600], and a second call replaces the first.
3. **Restarts:** jobs survive a scheduler restart. A missed recurring job fires once and advances. A missed one-shot fires once and is deleted.
4. **Overlap:** a firing is skipped while the earlier prompt is still pending.
5. **Expiry:** a recurring job is deleted after 7 days, using the injected clock.
6. **Session removal:** deleting or archiving a session deletes its jobs.
7. **Limits:** the 21st job is refused, and a sub-agent session is refused.
8. **Two schedulers:** two scheduler instances on one database fire a due job exactly once.
9. **Hooks:** `UserPromptSubmit` hooks do not run for scheduled prompts.
10. **`/loop`:** each form expands to the right instructions, and a config `loop` command overrides it.
11. **App:** the chip and panel helpers and the cancel request (browser suite).

## Out of scope

- Changes to Routines.
- Syncing schedules across machines.
- Jitter and per-job time zones.
- Worktree tools and the status line (own specs).
