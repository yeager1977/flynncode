# Codex / Claude parity follow-ups — implementation plan

**Goal:** meet the last-24h features against the requested functionality and close the parity gap to Codex/Claude Desktop where it is low-effort and local.

**Architecture:** each lane is independent and can be implemented by its own agent; all lanes keep the existing Flynncode surfaces (dispatch panel, review browser, routines plugin, artifacts sidebar, checkout handoff). Nothing reuses a cloud/Copilot surface.

**Principles:** tests from package root only, `bun typecheck` clean, minor UI changes only, reuse the same modal/tooltip style as the existing component.

---

## Lane 1 — Dispatch → activity inbox (`packages/app`)

**Goal:** finished work resurfaces instead of hiding in a static 40-cap list.

1. In `dispatch-store.ts`, mark a task unread when its `inboxStatus` transitions from `running|blocked|needs-input` to `done|failed`. Persist with the task (local store).
2. In `dispatch-panel.tsx`, add three filter tabs: `All / Unread / Running / Waiting`. Each is a memoized filter over the current task list rendered through the existing item row. Unread count becomes a small badge on the panel header.
3. Notification: reuse the existing OS notification path (`notification.tsx`); fire when a task status transitions to `done|failed` while the window is not focused. Do not fork the notification code.
4. Tests: extend `dispatch-panel.test.tsx` with filter and transition cases.

## Lane 2 — Review browser annotation capture (`packages/app`)

**Goal:** an annotation carries what the agent needs to see.

1. Extend `browserAnnotation` (currently in `hunk-revert.ts`) to carry markdown path, rect, and an optional data-URL thumbnail (captured at send time). Desktop main process captures via `webContents.capturePage` when marked; when capture is unavailable, keep the rect-only annotation. Do **not** add new OS dependencies.
2. When the user clicks the comment entry point, serialize the thumbnail into the same `addCommentToContext` flow as text notes. The model receives a combined "path - note - rect - thumbnail" message.
3. Add a small "Re-check page" button in the browser panel that re-fires the annotation with the same coords. No new IPC.
4. Tests: extend `review-browser.test.tsx` (or add `review-capture.test.ts`); assert the annotation includes the thumbnail when provided, and falls back to rect-only otherwise.

## Lane 3 — Routines: cadence + recovery + records (`packages/flynncode`)

**Goal:** a local routine can be hourly/weekly and survive app restart, with an inspectable run history.

1. `parse.ts`: accept `schedule: "manual" | { dailyAt?: string } | { interval?: string }`, where interval is one of `15m|1h|6h|1d|1w`. Keep `dailyAt` handling and validation as-is otherwise. Contract-test all three shapes.
2. `due.ts`: on startup-elapsed — if the routine is `dailyAt` and no run is recorded for the scheduled local-day while `now` is past that day, fire once instead of waiting 24h more. Interval shape computes `nextRun = lastRun + interval`.
3. `index.ts`: own the run-record writer — append a JSONL record `{ routineId, sessionID, agent, startedAt, endedAt, state, error? }` to `<Global.Path.state>/routines-runs.jsonl`, capped at the last 200 records . Skip records trimmed from the file.
4. Tests: matrix over `{manual, dailyAt (today, yesterday, missed), interval}` with the existing deterministic clock from `due.test.ts`; record writer parses/writes/caps as expected.

## Lane 4 — Artifacts: typed union (`packages/app`)

**Goal:** screenshot and note artifacts have a typed home, no longer ad-hoc.

1. In `sidebar-artifacts.ts`, switch the store to
   `Artifact = { type: "diff" | "file" | "screenshot" | "note"; sessionID: string; ... }`
   and persist per type. Keep `session_diff` rendering unchanged.
2. Refactor the sidebar component to render per-type rows and a small filter row (`All / Changed / Screenshots / Notes`) stored in localStorage. Keep the 20-group cap solely for `diff` groups.
3. When Lane 2 ships, accept the captured screenshot into the artifact store with the session id.
4. Tests: extend `sidebar-artifacts.test.ts`.

## Lane 5 — Checkout handoff: carry context (`packages/flynncode` + `packages/app`)

**Goal:** a handoff keeps the conversation meaningful in the destination.

1. In `packages/flynncode/src/worktree`, add `handoff { from, to }` that rejects identical paths and unknown source, and does the actual filesystem/link work; reuse the existing `copy` helper. Register the endpoint under the same experimental route as `worktree`/`worktreeRemove`.
2. In the app, route the handoff branch of `checkout-handoff.ts` through existing UI surfaces: call the endpoint, then start a new session in the destination bound to the same first-prompt text. Archive or mark the source session as "moved" when explicitly selected. Non-git projects stay disabled with the same message copy.
3. Edges: if the destination does not exist yet, the endpoint should fail with the existing form error; if the source session is missing, allow the move with an empty new session and surface a toast.
4. Tests: opencode worktree tests assert handoff rejects identical paths, copies semantics, and errors on unknown FROM; app decision tests assert the move notes behavior in `checkout-handoff.test.ts`.

---

## Agent grouping

| Lane | Agent scope | Package paths |
|---|---|---|
| 1 | implementer + reviewer | `packages/app/src/pages/dispatch/*`, `src/context/notification.tsx` |
| 2 | implementer + reviewer | `packages/app/src/pages/session/review-browser.tsx`, `hunk-revert.ts` |
| 3 | implementer + reviewer | `packages/flynncode/src/plugin/routines/*`, `app/.../settings-v2/routines.tsx` |
| 4 | implementer + reviewer | `packages/app/src/pages/layout/sidebar-artifacts.*` |
| 5 | implementer + reviewer | `packages/flynncode/src/worktree/*`, `app/.../session-header.tsx` |

Reserved/out-of-scope: cloud, Web Push, full RRULE, full `/review` web-submit, Codex cloud triggers. Every lane touches a disjoint file set and commits independently.

## Dependency order

- Lane 4 accepts the Lane 2 screenshot shape verbatim; Phase 4 can commit with the types in place and wire Lane 2 later.
- Lane 5 relies on the already-landed occupied-guard `checkout-handoff` fix.
- Lanes 1–3 ship independently and can land in any order.