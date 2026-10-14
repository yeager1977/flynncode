# Usage Limit Stop-and-Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions and subagents stop and report on provider usage limits instead of waiting out `retry-after`, configurable via `rate_limit` in config and Settings.

**Architecture:** A browser-safe classifier in core decides "usage limit + reset time". The legacy retry policy consults it with the configured `rate_limit` and ends the schedule so the existing `halt` records the `APIError`. The `task` tool turns a usage-limit child error into a status report and gains a `model` parameter. The app renders the error as a usage-limit card with Switch model, shows a "Usage limit" subagent state, and adds a Settings section.

**Tech Stack:** Effect (server), Effect Schema config, SolidJS app, Bun tests.

Spec: `docs/superpowers/specs/2026-10-14-usage-limit-stop-design.md`

## Global Constraints

- Follow `AGENTS.md` (repo root) style: no `else`, no destructuring, no aliased/star imports, `const`, minimal single-use helpers; Effect: bind services to named variables, no nested yields; avoid try/catch.
- `packages/app/AGENTS.md`: never hardcode user-visible English; use i18n keys (add to `packages/app/src/i18n/en.ts` and the `keys` list in `packages/app/src/i18n/flynncode-fallback.ts`). Prefer `createStore` over multiple signals.
- Tests run only from package dirs (`packages/core`, `packages/flynncode`: `bun test <file>`; `packages/app`: `bun test --conditions=solid --preload ./happydom.ts <file>`, full `bun run test:unit`). Typecheck with `bun typecheck` in each touched package.
- Config: `rate_limit.on_limit` is `"stop" | "retry"` (default `"stop"`), `rate_limit.retry_under` is non-negative seconds (default `0`).
- The classifier must not import node builtins (it is bundled into the desktop renderer).
- Never commit unrelated working-tree changes (bun.lock, packages/flynncode/package.json, packages/mobile-gateway/src/bin.ts, docs/superpowers/**): `git add` only your files. Commit messages `type(scope): summary` ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Usage-limit classifier (core)

**Files:** Create `packages/core/src/session/usage-limit.ts`, test `packages/core/test/session/usage-limit.test.ts` (match the package's existing test layout; check where core tests live).

**Produces:** `export function usageLimit(error: { name: string; data?: unknown } | undefined, now = Date.now()): { message: string; resetAt?: number } | undefined`.

- [ ] Failing tests: 429 statusCode → limit; message "Rate limit exceeded" (no status) → limit; responseBody containing `insufficient_quota` / `FreeUsageLimitError` / `resource_exhausted` → limit; 503 "overloaded" → undefined; non-APIError (`ContextOverflowError`) → undefined; `retry-after: "120"` → `resetAt = now + 120000`; `retry-after-ms: "5000"` → `now + 5000`; HTTP-date `retry-after` → that time; no headers → `resetAt` undefined. `message` is `data.message` (fallback: the error name).
- [ ] Run, see failures. Implement (only `APIError` errors: `name === "APIError"`; read `data.statusCode`, `data.message`, `data.responseBody`, `data.responseHeaders` defensively since `data` is `unknown`).
- [ ] Tests pass; `bun typecheck` in packages/core; commit `feat(core): classify provider usage limits`.

### Task 2: `rate_limit` config + SDK types

**Files:** `packages/core/src/v1/config/config.ts` (next to `subagent_depth` ~line 143), config tests in packages/core or packages/flynncode (follow where existing config decode tests live), regenerated SDK (`./packages/sdk/js/script/build.ts` from repo root; and `bun run generate` in `packages/client` if the HttpApi schema includes Config — check AGENTS.md).

- [ ] Failing test: config with `rate_limit: { on_limit: "retry", retry_under: 30 }` decodes; invalid `on_limit` is rejected; absent is allowed.
- [ ] Add optional `rate_limit: Schema.optional(Schema.Struct({ on_limit: Schema.optional(Schema.Literals(["stop", "retry"])), retry_under: Schema.optional(NonNegativeInt) }))` with descriptions.
- [ ] Regenerate SDK; confirm `rate_limit` appears in `packages/sdk/js/src/v2/gen/types.gen.ts` `Config`. Commit only regenerated files that changed because of this key (if regeneration produces large unrelated churn, stop and report NEEDS_CONTEXT with the diff stat).
- [ ] Typecheck core, flynncode, app; commit `feat(core): add rate_limit config`.

### Task 3: Retry policy stops on usage limits

**Files:** `packages/flynncode/src/session/retry.ts` (`policy` ~180-200), `packages/flynncode/src/session/processor.ts` (~674-688 `Effect.retry(SessionRetry.policy({...}))`), tests `packages/flynncode/test/session/retry.test.ts` and the processor tests that cover retry (find them).

**Consumes:** `usageLimit` (Task 1), `config.rate_limit` (Task 2).

- [ ] Failing tests (policy): with `{ onLimit: "stop", retryUnder: 0 }` a 429 APIError ends the schedule at attempt 1 and never calls `set`; with `retryUnder: 60` and `retry-after: "10"` it retries; with `retry-after: "3600"` it stops; with `onLimit: "retry"` behaviour equals today's; a 503 overload still retries in every mode.
- [ ] Implement: `policy` takes `onLimit` and `retryUnder` (seconds); when `usageLimit(error)` is defined and `onLimit === "stop"` and the computed delay `> retryUnder * 1000`, return `Cause.done(meta.attempt)`.
- [ ] Processor passes `onLimit: cfg.rate_limit?.on_limit ?? "stop"`, `retryUnder: cfg.rate_limit?.retry_under ?? 0` (read via the existing `config.get()` in `process`). Failing-then-passing processor test: a usage-limit stream error leaves the assistant message with the APIError, publishes `Session.Event.Error`, status ends `idle`, and no `retry` status was set.
- [ ] `bun test test/session`, typecheck; commit `feat(opencode): stop sessions on usage limits instead of waiting`.

### Task 4: Task tool report + `model` parameter

**Files:** `packages/flynncode/src/tool/task.ts` (params ~48-73, model choice ~303-306, `runTask` ~328-357), tests in `packages/flynncode/test/tool/task*.test.ts` (find existing).

- [ ] Failing tests: (a) child ends with a usage-limit APIError → tool output (not a failure) contains "usage limit", the model `provider/model`, the reset time when present, the child's todos and last text, and `task_id`; (b) other child errors still fail as `Subagent failed (task_id: …)`; (c) `model: "provider/model"` makes the child prompt use that model and records it in metadata; (d) unknown model → tool error naming it.
- [ ] Implement: add `model: Schema.optional(Schema.String)` with description ("provider/model to run this task on; use it to resume a task_id on a different model after a usage limit"). Resolve through the existing provider service (look up how models are parsed elsewhere, e.g. `Provider.parseModel` / `getModel`). On usage-limit error, build the report from the child session's todos (find the todo service used by the todo tool) and last text part. Keep report copy concise; this is model-facing text, not UI.
- [ ] Tests pass, typecheck; commit `feat(opencode): report usage limits from subagents and allow a task model`.

### Task 5: App — error card, subagent state, Settings section

**Files:** the component that renders an assistant message's `error` in the session timeline (find it: grep packages/app and packages/session-ui for where `info.error` / assistant `error` is displayed), `packages/app/src/pages/session/subagent-list-view.tsx` (~108-111), `packages/app/src/pages/session/subagent-list.ts` (~21-22), `packages/app/src/pages/dispatch/activity-status.ts` (~7), `packages/app/src/components/settings-v2/models.tsx` (add section; mirror `permissions.tsx` save pattern via `serverSync().updateConfig`), i18n files.

- [ ] Pure helper(s) with tests (e.g. subagent state from status + last assistant error; settings value ↔ config mapping).
- [ ] Error card: when `usageLimit(error)` is defined show title "Usage limit reached on {{model}}", optional "Resets around {{time}}" (locale time format already used in the app), the provider message, and a **Switch model** button that triggers the composer's model picker (`command` id `model.choose`, check `use-composer-commands.tsx`).
- [ ] Subagent list/activity: usage-limited child shows a "Usage limit" label.
- [ ] Settings → Models: "Rate limits" section with `SelectV2` (Stop and report / Keep retrying) and a number input (seconds, ≥ 0) disabled when "Keep retrying".
- [ ] Typecheck, `bun run test:unit`, browser suite; commit `feat(app): show usage limits and add rate limit settings`.

### Task 6: Verify and ship (controller)

- [ ] Visual check in the built-in browser against a loopback scratch server (OPENCODE_DB=opencode-local.db) with a provider that returns 429.
- [ ] Final whole-branch review; fixes.
- [ ] `OPENCODE_CHANNEL=dev` deb build, verify, copy to ~/Downloads, merge to dev.
