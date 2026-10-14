# Stop and report on usage limits

Date: 2026-10-14
Status: approved in chat

## Problem

When a provider returns a rate/usage limit (429, "rate limit", quota), the legacy session loop
(`packages/flynncode/src/session/processor.ts` + `session/retry.ts`) retries up to 5 times and
honours the provider's `retry-after` literally (capped only at ~24.8 days). Plan limits say
"retry in hours", so sessions — including `task` subagents — sit in a `retry` countdown for
hours. The `task` tool has no timeout and never learns its child is waiting; the subagent list
shows "running". Nothing is configurable, and the `task` tool cannot choose a model.

## Decisions (owner, 2026-10-14)

- Default: **stop and report** on a usage limit — no countdown.
- **Any** rate/usage limit stops by default (threshold configurable, default 0 s).
- Applies to the **main session and subagents**.
- Configurable in **opencode.jsonc and a Settings section**.
- No automatic fallback-model list in this change.

## Design

### Classification (shared, browser-safe)

New `packages/core/src/session/usage-limit.ts`, importing nothing from node:
`usageLimit(error)` takes an error object of the `{ name, data }` shape and returns
`{ message, resetAt?: number }` when it is a usage limit, else `undefined`.
A usage limit is an `APIError` with `statusCode === 429`, or whose message/response body matches
rate-limit/quota patterns (`rate limit|rate_limit|too many requests|resource exhausted|
resource_exhausted|insufficient_quota|quota|usage limit|FreeUsageLimitError|GoUsageLimitError`).
A 5xx status vetoes the text heuristics: overload/5xx/network errors are not usage limits.
`resetAt` comes from `retry-after-ms` or `retry-after` (seconds or HTTP date). `x-ratelimit-reset*`
headers are not used: providers disagree on whether they are epochs, durations or strings.
Used by the server (stop decision, task report) and the app (error card, subagent state).

### Config

`packages/core/src/v1/config/config.ts`:

```jsonc
"rate_limit": {
  "on_limit": "stop",   // "stop" (default) | "retry" (previous behaviour)
  "retry_under": 0      // seconds; with "stop", a limit whose retry-after is <= this is still retried
}
```

Both optional; missing means `stop` / `0`. Regenerate the SDK so the app's `Config` type has it.

### Server stop

`SessionRetry.policy` gains `{ onLimit, retryUnder }`. For an error where `usageLimit()` is
defined: with `on_limit: "retry"` behave exactly as today; with `"stop"` retry only when the
computed delay is `<= retry_under * 1000`, otherwise end the schedule so the existing `halt`
records the `APIError` on the assistant message and the session goes idle. The processor reads
`config.rate_limit` per process call. Non-limit errors are unchanged.

### Task tool

- When the child's assistant error is a usage limit, the tool returns (not fails) a report:
  stopped on usage limit, provider/model, reset time if known, the provider message, the child's
  todo list (completed/pending) and last text output, the `task_id`, and the instruction to resume
  with `task_id` and a different `model`. Other failures are unchanged.
- New optional parameter `model` (`"provider/model"`). When set it overrides the agent's model for
  that run (new or resumed task). Invalid/unknown model → tool error naming the model.

### App

- Session timeline: an assistant error that `usageLimit()` recognises renders as
  "Usage limit reached on {model}" with "resets around {time}" when known, the provider message,
  and a **Switch model** button that opens the composer's model picker.
- Subagent list / activity status: a child whose last assistant message ended in a usage limit
  shows a "Usage limit" state instead of "running"/"done".
- Settings: a **Rate limits** section (on the Models tab) with a select "When a model hits a usage
  limit: Stop and report / Keep retrying" and a number "Still retry limits shorter than N seconds",
  saved through `serverSync().updateConfig({ rate_limit })`, mirroring the Permissions page.
- All copy via i18n keys (en + flynncode fallback).

## Testing

- core: `usageLimit` classification (429, patterns, quota, 5xx not a limit, resetAt parsing).
- flynncode: policy stops/retries per config and threshold; processor records the error and goes
  idle without a retry status; task tool report on usage limit; `model` parameter override and
  invalid model error; config decodes `rate_limit`.
- app: Settings section saves; error card renders for a usage-limit error (pure helpers tested,
  then visual check in the browser against a scratch server whose provider returns 429).
