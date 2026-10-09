# WS12: One activity inbox — running, needs-input, blocked across dispatch + routines + sessions

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three thin lists (dispatch panel capped at 40, routines settings tab, per-session notification badges) with one Activity inbox dialog that shows every supervised run — dispatch tasks, routine runs, and live sessions — unified under running / needs-input / blocked / done / failed with filters, reusing the existing notification index and dispatch watcher. No second notification system, no new backend, no vendor clouds.

**Architecture:** All aggregation happens client-side in the desktop web app from state that already exists: persisted dispatch tasks (`dispatch.v1`), live session status + question/permission queues (`serverSync().session.data`), the notification index (`useNotification()` unseen counts), and routine definitions plus inline run history (`serverSync().data.config.routines` via `routinesFromConfig`, which already carries `lastRun` + `recentRuns`). The existing `activity-status.ts` mapping (`busy`/`retry` → running, idle + waiting queues → needs-input, error → failed, stored terminal preserved over live idle) becomes the single status resolver for all three kinds; dispatch "blocked" stays a stored-only state until a real producer exists. The `DispatchActivityProvider` watcher keeps owning unread flags and OS notify on terminal transitions — the inbox only reads and marks-read through it. The panel keeps its dispatch send form; routines rows link to the settings routines tab instead of duplicating run controls. Sidebar badge switches from dispatch-only unread to inbox-wide unread.

**Tech Stack:** Bun + TypeScript monorepo (`dev` branch). SolidJS dialog in `packages/app/src/pages/dispatch/`, pure status/store functions with `bun test`, typed i18n via `language.t(...)` with source keys in `packages/app/src/i18n/en.ts` (en only). No new dependencies. No server/API changes: inbox reads `session.status`, `session.active`, config routines — all existing.

## Global Constraints

- UI copy via i18n keys in `packages/app/src/i18n/en.ts` only (en only); never hardcode user-visible English in production code.
- No `any` type anywhere.
- No star imports and no aliased imports; import the module's own exported namespace by name where a namespace is needed (e.g. `import { ActivityInbox } from "@/pages/dispatch/activity-inbox"`).
- Dot notation over destructuring, `const` over `let`, early returns over `else`, `createStore` over multiple `createSignal`.
- Do not build a second notification system: unread + OS notify stay in `DispatchActivityProvider` + `useNotification()`; the inbox reads and marks-read only.
- Backends self-hosted or user-owned only; vendor-hosted clouds, Sites hosting, and voice products stay OUT. No deepthought relay in this workstream.
- Tests run from package dirs (`packages/app`), never repo root; typecheck with `bun typecheck` from package dirs, never `tsc` directly.
- Branch name: `activity-inbox` (max three words, hyphens, no slashes/prefixes). Commits use `type(scope): summary`.

---

## Files to create/modify

| # | Path | Change |
|---|------|--------|
| 1 | `packages/app/src/pages/dispatch/activity-status.ts` | Modify: add `InboxKind` (`"dispatch" \| "routine" \| "session"`), `InboxStatus` (reuse `ActivityStatus`), `inboxRowStatus(kind, stored, live, waiting)` resolver; keep `activityStatus`/`inboxStatus` byte-identical for existing callers. |
| 2 | `packages/app/src/pages/dispatch/activity-inbox.ts` | Create: pure row builders — `dispatchRows(tasks, liveOf)`, `routineRows(routines)`, `sessionRows(sessions, statusOf, unseenOf)` — plus `filterInbox(rows, filter)` and `inboxUnread(rows)`; row shape `{ key, kind, title, subtitle, status, unread, sessionID?, directory? }` with no Solid imports. |
| 3 | `packages/app/src/pages/dispatch/activity-inbox.tsx` | Create: `ActivityInboxPanel` dialog (send form kept from `DispatchPanel`, filter tabs, grouped row list, open/mark-read actions); consumes `useDispatchActivity`, `useNotification`, `useServerSync`, `useNavigate`. |
| 4 | `packages/app/src/pages/dispatch/dispatch-panel.tsx` | Modify: re-export or delegate to `ActivityInboxPanel` so the existing lazy import in `packages/app/src/pages/layout.tsx:1108` keeps working; delete duplicated list logic once the delegate renders. |
| 5 | `packages/app/src/pages/layout/sidebar-shell.tsx` | Modify: dispatch button badge reads inbox-wide unread (dispatch unread + notification unseen for tracked sessions); `aria-label` uses new `inbox.*` keys. |
| 6 | `packages/app/src/i18n/en.ts` | Modify: add `inbox.*` keys (title, filters, kind labels, empty states, open/mark-read); keep existing `dispatch.*`, `notification.*`, `settings.routines.*` values byte-for-byte. |
| 7 | `packages/app/src/pages/dispatch/activity-status.test.ts` | Modify: extend with `inboxRowStatus` cases (stored terminal preserved over live idle; waiting idle → needs-input; routine failed run → failed). |
| 8 | `packages/app/src/pages/dispatch/activity-inbox.test.ts` | Create: pure-function tests for row builders + filter + unread count (no mocks, no `globalThis`). |
| 9 | `packages/app/src/pages/dispatch/dispatch-panel.test.tsx` | Modify: keep passing against the delegate (assert dialog renders inbox tabs + send form via new i18n keys). |

Import rules for all edits: no `any`, no star imports, no aliased imports; routines parsing reuses `routinesFromConfig` from `@/components/settings-v2/routines-edit` (same import style as `settings-v2/routines.tsx:9`).

## Interfaces

- `inboxRowStatus(kind, stored, live, waiting)` consumes `(InboxKind, ActivityStatus, { type?: string; blocked?: boolean } | undefined, boolean)`, produces `ActivityStatus`. Rules: no live → stored; live idle + waiting → needs-input; live idle without waiting → stored (terminal preserved); else `activityStatus(live)`. `kind` is accepted for future routine-specific mapping and ignored today — documented, not branched on.
- `InboxRow` consumes task/routine/session inputs listed in file 2, produces `{ key: string; kind: InboxKind; title: string; subtitle: string; status: ActivityStatus; unread: boolean; sessionID?: string; directory?: string }`. Dispatch rows: `key = sessionID`, unread from task + notification unseen. Routine rows: `key = routine:<id>`, status from last `recentRuns` entry (`ok` → done, otherwise failed; no runs → done when idle, never running), unread true when latest run failed. Session rows (non-dispatch live sessions): `key = session:<id>`, status via `inboxRowStatus` with stored `running`, unread from `notification.session.unseenCount`.
- `filterInbox(rows, filter)` consumes rows + `"all" | "running" | "needs-input" | "blocked" | "done" | "unread"`, produces filtered rows. `needs-input` and `blocked` are separate tabs (Codex parity); existing dispatch `waiting` tab maps to `needs-input` and is removed.
- Panel open action consumes an `InboxRow`, produces navigation + `markDispatchRead(sessionID)` for dispatch rows or `notification.session.markViewed(sessionID)` for session rows; routine rows navigate to settings routines tab. Produces no new persisted state and no new events.
- i18n keys consumed via `language.t(key)`; produced by `en.ts` additions: `inbox.title`, `inbox.filterAll`, `inbox.filterRunning`, `inbox.filterNeedsInput`, `inbox.filterBlocked`, `inbox.filterDone`, `inbox.filterUnread`, `inbox.kindDispatch`, `inbox.kindRoutine`, `inbox.kindSession`, `inbox.empty`, `inbox.emptyFilter`, `inbox.open`, `inbox.markRead`, `inbox.routineHistory`, `inbox.failedRun`.

---

### Task 1: Baseline probe (read-only, no commit)

**Files:** none modified.

- [ ] **Step 1: Confirm the three thin lists and their seams**

Run from repo root: `grep -rn "LIMIT" packages/app/src/pages/dispatch/dispatch-store.ts`, `grep -n "setInterval" packages/opencode/src/plugin/routines/index.ts`, `grep -n "MAX_NOTIFICATIONS\|unseenCount" packages/app/src/context/notification.tsx`. Record outputs in your working notes.
Expected: `LIMIT = 40`, `setInterval(...30_000)`, `MAX_NOTIFICATIONS = 500` with session/project unseen indexes.

- [ ] **Step 2: Run the existing dispatch suites as baseline**

Run: `bun test src/pages/dispatch/` with `workdir` `packages/app`.
Expected: passes, 0 failures — record test/file counts before changing code.

### Task 2: Unify the status resolver

**Files:**
- Modify: `packages/app/src/pages/dispatch/activity-status.ts`
- Test: `packages/app/src/pages/dispatch/activity-status.test.ts`

**Interfaces:**
- Consumes: existing `ActivityStatus`, live `{ type, blocked }` shapes from `serverSync().session.data.session_status` + question/permission queue lengths.
- Produces: `InboxKind`, `inboxRowStatus(kind, stored, live, waiting)` per the Interfaces section; `activityStatus`/`inboxStatus` unchanged.

- [ ] **Step 1: Write the failing test**

In `activity-status.test.ts` append a `describe("inboxRowStatus")` block with five tests: (1) no live returns stored `done`; (2) live idle without waiting returns stored `done`; (3) live idle with waiting returns `needs-input`; (4) live busy returns `running`; (5) `kind: "routine"` with no live returns stored `failed` (kind accepted, mapping identical — asserts the documented no-branch rule).
Run: `bun test src/pages/dispatch/activity-status.test.ts` with `workdir` `packages/app`.
Expected: fails (missing export), 5 new tests error.

- [ ] **Step 2: Implement the resolver**

In `activity-status.ts`: add `export type InboxKind = "dispatch" | "routine" | "session"`, then `export function inboxRowStatus(kind: InboxKind, stored: ActivityStatus, live?: { type?: string; blocked?: boolean }, waiting = false): ActivityStatus` with early returns (no live → stored; live idle → waiting ? needs-input : stored; else activityStatus(live)). Reference `kind` only in a comment stating it is reserved for future routine-specific mapping. Do not touch `activityStatus`/`inboxStatus` bodies.
Run: `bun test src/pages/dispatch/activity-status.test.ts` with `workdir` `packages/app`.
Expected: passes, all tests green.
Commit: `feat(app): unify inbox status resolution`.

### Task 3: Pure inbox row builders

**Files:**
- Create: `packages/app/src/pages/dispatch/activity-inbox.ts`
- Create: `packages/app/src/pages/dispatch/activity-inbox.test.ts`

**Interfaces:**
- Consumes: `DispatchTask[]` (+ `liveOf: (id: string) => ActivityStatus`), `StoredRoutine[]` (shape from `routinesFromConfig`), live session infos + `statusOf`/`unseenOf` callbacks.
- Produces: `InboxRow[]`, `filterInbox`, `inboxUnread` per the Interfaces section. No Solid imports; no `any`.

- [ ] **Step 1: Write the failing test**

Create `activity-inbox.test.ts` importing from `./activity-inbox`, covering: dispatch row keeps unread + live status; terminal dispatch preserved over idle; routine row with latest failed run → `failed` + unread; routine with no runs → `done`, read; session row idle + unseen → `needs-input` + unread; `filterInbox` splits `needs-input` vs `blocked`; `inboxUnread` counts unread rows. Use plain object literals for inputs (no mocks, no `globalThis`).
Run: `bun test src/pages/dispatch/activity-inbox.test.ts` with `workdir` `packages/app`.
Expected: fails (module missing).

- [ ] **Step 2: Implement builders**

Create `activity-inbox.ts` with `InboxRow`, `InboxFilter`, `dispatchRows`, `routineRows`, `sessionRows`, `filterInbox`, `inboxUnread` exactly as specified. Routine subtitle is the schedule string (`rrule ?? dailyAt ?? interval ?? manual` — pass the already-resolved display string in, do not import i18n here). Sort: `needs-input`/`blocked` first, then `running`, then terminal by recency signal carried on the row (`unread` first within group); implement as one comparator, no `else` branches.
Run: `bun test src/pages/dispatch/activity-inbox.test.ts` with `workdir` `packages/app`.
Expected: passes, 0 failures.
Commit: `feat(app): add pure activity inbox row builders`.

### Task 4: English i18n keys

**Files:**
- Modify: `packages/app/src/i18n/en.ts`

**Interfaces:**
- Consumes: nothing. Produces the 14 `inbox.*` keys listed in Interfaces, en only; other locales fall back per the shared i18n module (do not hand-translate).

- [ ] **Step 1: Add the keys**

In `en.ts` directly after line 988 (`"dispatch.filterWaiting": "Waiting",`) insert exactly: `"inbox.title": "Activity"`, `"inbox.filterAll": "All"`, `"inbox.filterRunning": "Running"`, `"inbox.filterNeedsInput": "Needs input"`, `"inbox.filterBlocked": "Blocked"`, `"inbox.filterDone": "Done"`, `"inbox.filterUnread": "Unread"`, `"inbox.kindDispatch": "Dispatch"`, `"inbox.kindRoutine": "Routine"`, `"inbox.kindSession": "Session"`, `"inbox.empty": "No activity yet. Dispatched tasks, routine runs, and live sessions will appear here."`, `"inbox.emptyFilter": "Nothing matches this filter."`, `"inbox.open": "Open"`, `"inbox.markRead": "Mark read"`, `"inbox.routineHistory": "Recent runs"`, `"inbox.failedRun": "Failed"`. Preserve byte-for-byte the neighboring `dispatch.*` values.
Run: `bun typecheck` with `workdir` `packages/app`.
Expected: exit 0.
Commit: `feat(app): add activity inbox copy`.

### Task 5: Activity inbox panel

**Files:**
- Create: `packages/app/src/pages/dispatch/activity-inbox.tsx`
- Modify: `packages/app/src/pages/dispatch/dispatch-panel.tsx`

**Interfaces:**
- Consumes: `useDispatchActivity()` (`desk`, `setDesk`, `ready`, `markRead`), `useNotification()` (session unseen counts, `markViewed`), `useServerSync()` (`session.data.session_status/question/permission`, `session.data.session` list, `data.config.routines`), `sdk().client.session` (`create`, `prompt`, `active`), `useNavigate`, `language.t(...)`.
- Produces: `ActivityInboxPanel` dialog with the dispatch send form (unchanged behavior/keys), six filter tabs (`all/running/needs-input/blocked/done/unread`), grouped rows with kind label + status + unread dot, per-row Open / Mark-read buttons with `data-action="inbox-open"` / `data-action="inbox-mark-read"`.

- [ ] **Step 1: Build the panel**

Create `activity-inbox.tsx`: (a) keep the send form from `dispatch-panel.tsx:102-144` verbatim (same SDK calls, same `dispatch.*` keys, same `addDispatch`/`completeDispatch`/`failDispatch` updates); (b) build rows with the Task-3 builders — `liveOf` from `session_status` + question/permission lengths via `inboxRowStatus("dispatch", ...)`, routines via `routinesFromConfig(serverSync().data.config.routines)` (same call pattern as `settings-v2/routines.tsx:17`), sessions from `sync().data.session` excluding IDs already present as dispatch rows; (c) filter tabs with `role="tablist"`, `aria-selected`, `language.t(filterKey)`; (d) open action marks read then navigates (dispatch/session) or navigates to settings routines tab (routine rows); (e) empty states use `inbox.empty` / `inbox.emptyFilter`; (f) every user-visible string via `language.t(...)`. Keep the `session.active()` reconcile effect from `dispatch-panel.tsx:84-91` unchanged.
Run: `bun typecheck` with `workdir` `packages/app`.
Expected: exit 0.

- [ ] **Step 2: Delegate the old panel**

In `dispatch-panel.tsx`: replace the component body with a delegate rendering `ActivityInboxPanel` (keep the exported `DispatchPanel` name and the lazy import in `layout.tsx:1108` working), deleting the duplicated `liveStatus`/`filteredTasks`/list markup. Keep `filterKey`/`statusKey` only if the delegate needs them; otherwise delete.
Run: `bun test src/pages/dispatch/dispatch-panel.test.tsx` with `workdir` `packages/app`.
Expected: passes after updating key assertions to `inbox.*` (do that update in this step, not Task 4).
Commit: `feat(app): show unified activity inbox in dispatch panel`.

### Task 6: Sidebar badge reads inbox-wide unread

**Files:**
- Modify: `packages/app/src/pages/layout/sidebar-shell.tsx`

**Interfaces:**
- Consumes: dispatch unread count + `notification.session` unseen counts for tracked session IDs.
- Produces: badge count = dispatch unread + unseen in non-dispatch live sessions; tooltip/`aria-label` via `inbox.title`.

- [ ] **Step 1: Rewire the badge**

In `sidebar-shell.tsx` where the dispatch button badge renders: compute unread as `activity.unreadCount()` plus unseen counts for live sessions not already in `desk.tasks` (read via the same `useNotification` + `useServerSync` sources as Task 5; no new context). Change the label to `language.t("inbox.title")` with the count interpolated only if the existing pattern supports params — otherwise keep label bare and render the count in the badge element as today.
Run: `bun typecheck` with `workdir` `packages/app`.
Expected: exit 0.
Commit: `feat(app): badge sidebar on inbox-wide unread`.

### Task 7: Verify + harden tests

**Files:**
- Modify: `packages/app/src/pages/dispatch/dispatch-panel.test.tsx` (only if Task 5 left gaps), `packages/app/src/pages/dispatch/activity-inbox.test.ts` (edge cases only).

- [ ] **Step 1: Full dispatch suite + typecheck**

Run: `bun test src/pages/dispatch/` then `bun typecheck`, both with `workdir` `packages/app`.
Expected: all suites pass (activity-status, activity-inbox, dispatch-store, dispatch-panel), typecheck exit 0. If the dispatch cap (`LIMIT = 40`) drops rows the inbox should show, add a test in `activity-inbox.test.ts` asserting session rows still surface live sessions missing from the capped dispatch list — then re-run.
Commit: `test(app): cover inbox filtering and unread` (only if tests were added/changed in this task; otherwise no commit).

## Explicit non-goals

- No new server endpoints, no schema changes, no Protocol/HttpApi edits (and therefore no `bun run generate`).
- No changes to `packages/opencode/src/plugin/routines/` scheduling, RRULE expansion, or run history — WS7 (`2026-10-08-routine-cadence.md`) owns those; this plan only reads `config.routines` + inline `recentRuns`.
- No changes to notification persistence, TTL, OS-notify gating, or settings toggles.
- No TUI inbox (TUI keeps its existing attention/toast path); no phone/deepthought needs-input delivery (WS12 phone item stays separate).
- No removal of the routines settings tab — inbox routine rows link to it.
