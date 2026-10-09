# WS3: Background subagent stop and steer from the subagent list

## Goal

Make the existing subagent/task list the reliable place to stop or redirect a running child session, in both the desktop web app and the TUI, without leaving the session view.

## Architecture

1. **One interruption path covering both runtimes.** The desktop Stop button currently calls `client.session.abort`, which reaches V1 `SessionPrompt.cancel` → `SessionRunState.cancel`, and that function only cancels V1 `Runner` instances plus `BackgroundJob` entries (`packages/opencode/src/session/run-state.ts:77-86`). It never touches V2 `SessionExecution.interrupt` (`packages/core/src/session/execution.ts:17`), so a V2-owned drain keeps running after the user presses Stop. The fix is to call the process-global, Session-ID based `SessionExecution.interrupt(sessionID)` from the same cancel path; per `AGENTS.md` V2 rules idle/missing interruption is a no-op, so this is safe to add unconditionally, and no layer takes a Session ID beyond that call.
2. **Explicit steer delivery with honest UI state.** The desktop steer form posts `client.session.prompt` with no `delivery` field (`packages/app/src/pages/session/subagent-list-view.tsx:257-260`), relying on the server default. `PromptPayload` already carries `delivery` (`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:70`, inherited from `SessionPrompt.PromptInput` with `steer | queue`), and V2 semantics promote steers at the next safe provider-turn boundary while resetting the agent turn allowance. The fix is to send `delivery: "steer"` explicitly, disable the form unless the child is busy/retrying, and surface pending/error states. The TUI footer subagent inspector (`packages/opencode/src/cli/cmd/run/footer.subagent.tsx`) is view-only today; it gains Stop/Steer actions wired to the already-registered `session.interrupt` command and a steer submit reusing the existing prompt pipeline with `delivery: "steer"`.
3. **No new backends, no new placement.** Everything stays on the local host the user already runs (self-hosted/user-owned only per the constraint update). No vendor clouds, no Sites, no voice, no deepthought relay in this workstream. Stop targets the active process-local ownership chain for that Session; steer admits one durable input and schedules an advisory wake per the existing V1/V2 prompt paths.

## Tech Stack

- Bun + TypeScript monorepo (`dev` branch).
- Effect services: V1 `SessionPrompt` / `SessionRunState` (`packages/opencode/src/session/`), V2 `SessionExecution` (`packages/core/src/session/execution.ts`), `BackgroundJob` (`packages/opencode/src/background/job.ts`).
- HTTP API: `abort` (`SessionPaths.abort`), `prompt`/`promptAsync` with `PromptPayload.delivery` (`packages/opencode/src/server/routes/instance/httpapi/`).
- Desktop UI: SolidJS in `packages/app/src/pages/session/subagent-list-view.tsx`, typed i18n via `language.t(...)` with source keys in `packages/app/src/i18n/en.ts`.
- TUI: OpenTUI Solid in `packages/opencode/src/cli/cmd/run/footer.subagent.tsx`, state in `subagent-data.ts` / `footer.ts`.

## Files to create/modify

| # | Path | Change |
|---|------|--------|
| 1 | `packages/opencode/src/session/run-state.ts` | Modify: in `cancel`, after `cancelBackgroundJobs`, yield V2 `SessionExecution.Service` and call `interrupt` for the same session ID (idle = no-op). Add the core node to this layer's deps if the composition check in the task step shows it missing. |
| 2 | `packages/opencode/src/session/prompt.ts` | Read-only verification (cancel at line 191 delegates to `state.cancel`); modify only if the V2 interrupt belongs here instead of `run-state.ts` — default is file 1, keep this file untouched unless the layer check forces it. |
| 3 | `packages/app/src/pages/session/subagent-list-view.tsx` | Modify `Row`: Stop button calls abort then disables while the abort is in flight; steer form posts `parts` plus `delivery: "steer"`, trims/validates non-empty, clears on success, shows a toast on failure; both controls render only for busy/retry children and carry `data-action="subagent-stop"` / `data-action="subagent-steer"` hooks. Replace the steer input's `aria-label` (`dispatch.placeholder`) with a dedicated key. All copy via `language.t(...)`. |
| 4 | `packages/app/src/i18n/en.ts` | Modify: add `session.subagents.stop`, `session.subagents.stopping`, `session.subagents.steer.placeholder`, `session.subagents.steer.send`, `session.subagents.steer.sending`, `session.subagents.steer.failed`, `session.subagents.stop.failed`. English source copy only; other locales fall back per the shared i18n module (do not hand-translate). |
| 5 | `packages/app/src/pages/session/subagent-list-source.test.ts` | Modify: extend the existing source-wiring suite with stop/steer assertions (abort call, `delivery: "steer"`, i18n keys, `data-action` hooks, no hardcoded English). |
| 6 | `packages/opencode/src/cli/cmd/run/footer.subagent.tsx` | Modify: add Stop and Steer controls to the inspector header/footer for the selected running tab (Stop invokes the registered `session.interrupt` command path; Steer opens an inline input that submits through the existing prompt pipeline with `delivery: "steer"`). |
| 7 | `packages/opencode/src/cli/cmd/run/subagent-data.ts` | Modify only if needed to expose the selected tab's session ID + running status to the new controls; otherwise read-only. |
| 8 | `packages/opencode/src/cli/cmd/run/footer.ts` | Modify only if needed to route the new keybindings/actions through the existing footer state machine (`interrupt`/`exit` pattern at lines 964-994); otherwise read-only. |

Import rules for all edits: no `any`, no star imports, no aliased imports; import the V2 service as `import { SessionExecution } from "@opencode-ai/core/session/execution"` and reference `SessionExecution.Service`. Convert the V1 `SessionID` to the V2 ID brand at the call site with the brand constructor used by that module (same `ses_…` string brand); if the brands differ, decode through `Schema` instead of casting.

## Interfaces

- `SessionExecution.interrupt(sessionID)` consumes a Session ID string brand, produces `Effect<void>`, no-op when idle or unowned. Called from `SessionRunState.cancel` after background-job cancellation; consumes nothing new, produces no new events.
- `session.abort({ sessionID })` (HTTP `POST /session/:id/abort`) consumes `{ sessionID }`, produces boolean. After this work it stops V1 runners, cancels matching `BackgroundJob` entries (including children matched via `metadata.sessionId` / `metadata.parentSessionId`), and interrupts the V2 drain for the same ID.
- `session.prompt({ sessionID, parts, delivery })` (HTTP `POST /session/:id/message`, async variant `prompt_async`) consumes `{ sessionID, parts: [{ type: "text", text }], delivery: "steer" }`, produces the prompted message (sync) or `NoContent` (async). Steer promotes at the next safe provider-turn boundary and resets the agent's provider-turn allowance once per batch.
- `SubagentList Row` consumes `sync().data.session` (children via `parentID`), `sync().data.session_status`, and `sdk().client.session`; produces abort/prompt calls plus toasts. New `data-action` hooks (`subagent-stop`, `subagent-steer`) are consumed by tests and browser automation.
- i18n keys consumed via `language.t(key)` / `language.t(key, params)`; produced by `en.ts` additions listed in file 4.

## Tasks

### 1. Confirm the V2 gap with a failing-first probe

- **Action:** Read `packages/opencode/src/session/run-state.ts:77-86` and `packages/core/src/session/execution.ts:10-35`, then run `grep -rn "SessionExecution" packages/opencode/src/session/` from the repo root to confirm no V2 interrupt is reachable from the abort path. Record the exact grep output (empty except unrelated matches) in the task-1 commit message body.
- **Test:** `bun test src/pages/session/subagent-list-source.test.ts` with `workdir` `packages/app`. **Expected:** passes (baseline, 4 tests, 0 failures) — this step changes no code.
- **Commit:** none (read-only probe; do not commit).

### 2. Route V2 interruption through `SessionRunState.cancel`

- **Action:** In `packages/opencode/src/session/run-state.ts`, in `cancel`, after `yield* cancelBackgroundJobs(background, sessionID)` and before reading the runners map: yield `SessionExecution.Service` in the layer generator (add `const execution = yield* SessionExecution.Service` next to the existing `background`/`status` yields), then `yield* execution.interrupt(SessionExecution.ID.make(sessionID))` using the ID brand exported from `@opencode-ai/core/session/execution` (if that module exports no ID brand, use the `SessionSchema.ID` brand from `@opencode-ai/core/session` — check the module's exports first and use whichever brand the `interrupt` signature declares, no casting). Then inspect the `LayerNode.make` deps at the file bottom: if the core execution node is not already in the composed graph (check `packages/opencode/src/session/*.ts` layer wiring and `packages/core/src/session/execution/local.ts` for the node name), add it to the `deps` array. Keep the existing idle behavior: when there is no runner, still set status idle and return.
- **Test:** `bun typecheck` with `workdir` `packages/opencode`. **Expected:** exit 0, no errors.
- **Commit:** `fix(opencode): interrupt V2 drain on session cancel`.

### 3. Cover the new cancel path with a unit test

- **Action:** Add `packages/opencode/test/session/run-state-cancel.test.ts` (check `packages/opencode/test/` for the existing naming pattern first and match it) that builds the real `SessionRunState` layer with a stubbed `SessionExecution` recording received IDs, calls `cancel` for a session with no runner, and asserts the stub received exactly that session ID and status became idle. Do not mock `globalThis`; construct the layer with `Layer`/`Effect` test utilities already used in `packages/core/test/session-create.test.ts`. If no such test harness exists for `packages/opencode`, extend the step-5 source-wiring test instead and skip creating this file (state which in the commit body).
- **Test:** `bun test test/session/run-state-cancel.test.ts` (or the matched path) with `workdir` `packages/opencode`. **Expected:** passes, 1–2 tests, 0 failures.
- **Commit:** `test(opencode): cover V2 interrupt on session cancel`.

### 4. Add English i18n keys for stop/steer

- **Action:** In `packages/app/src/i18n/en.ts` directly after line 708 (`"session.subagents.taskChip.open"`), insert exactly: `"session.subagents.stop": "Stop"`, `"session.subagents.stopping": "Stopping..."`, `"session.subagents.steer.placeholder": "Steer this subagent..."`, `"session.subagents.steer.send": "Steer"`, `"session.subagents.steer.sending": "Steering..."`, `"session.subagents.steer.failed": "Could not steer this subagent."`, `"session.subagents.stop.failed": "Could not stop this subagent."`. Preserve byte-for-byte the existing neighboring values.
- **Test:** `bun typecheck` with `workdir` `packages/app`. **Expected:** exit 0.
- **Commit:** `feat(app): add subagent stop and steer copy`.

### 5. Harden the desktop subagent row stop/steer

- **Action:** In `packages/app/src/pages/session/subagent-list-view.tsx` `Row`: (a) add a `stopping` signal and a `steering` signal via `createSignal(false)`; (b) replace the bare abort `onClick` with an async handler setting `stopping`, awaiting `sdk().client.session.abort({ sessionID: props.child.id })`, showing a toast with `language.t("session.subagents.stop.failed")` on catch, and resetting `stopping`; add `data-action="subagent-stop"`, `disabled={stopping()}`, and label `stopping() ? language.t("session.subagents.stopping") : language.t("session.subagents.stop")`; (c) in the steer form `onSubmit`, set `steering`, await `sdk().client.session.prompt({ sessionID: props.child.id, parts: [{ type: "text", text }], delivery: "steer" })`, clear the input only on success, toast `language.t("session.subagents.steer.failed")` on catch, reset `steering`; add `data-action="subagent-steer"`, disable submit while `steering()` or `steer().trim()` is empty, use `aria-label={language.t("session.subagents.steer.placeholder")}` plus `placeholder={language.t("session.subagents.steer.placeholder")}` on the input, and submit label `steering() ? language.t("session.subagents.steer.sending") : language.t("session.subagents.steer.send")`; (d) keep both controls inside the existing `<Show when={expanded() && (status === "busy" || status === "retry")}>` block. Use the toast helper already imported/used in `session-header.tsx` (`showToast`); if `subagent-list-view.tsx` has no toast helper, import the same one `session-header.tsx` uses.
- **Test:** `bun test src/pages/session/subagent-list-source.test.ts` with `workdir` `packages/app`. **Expected:** fails until step 6 extends it — run before extending to confirm the new `data-action` hooks render (manual check), then proceed.
- **Commit:** `feat(app): harden subagent list stop and steer` (combine with step 6 if preferred; if combined, use this message and list both files).

### 6. Extend the source-wiring test for stop/steer

- **Action:** In `packages/app/src/pages/session/subagent-list-source.test.ts` append a `describe("subagent list stop + steer wiring")` block with four tests asserting on `viewSource`: (1) contains `client.session.abort` and `data-action="subagent-stop"` and `session.subagents.stop`; (2) contains `delivery: "steer"` and `data-action="subagent-steer"` and `session.subagents.steer.send`; (3) steer input uses `session.subagents.steer.placeholder` for `aria-label` and contains no `dispatch.placeholder` in this file's steer input; (4) no hardcoded English labels — `not.toMatch(/>\s*Stop\s*</)` and `not.toMatch(/>\s*Steer\s*</)` on element text (attribute values excluded by the `>` `<` anchors).
- **Test:** `bun test src/pages/session/subagent-list-source.test.ts` with `workdir` `packages/app`. **Expected:** passes, 8 tests total (4 existing + 4 new), 0 failures.
- **Commit:** `test(app): cover subagent stop and steer wiring`.

### 7. Add TUI Stop/Steer to the subagent inspector

- **Action:** In `packages/opencode/src/cli/cmd/run/footer.subagent.tsx`, in the header row next to the status/title (inside the existing `<Show when={tab()}>` block): (a) add a Stop affordance visible only when `tab().status === "running"` that dispatches through the already-registered `session.interrupt` command binding the same way `footer.prompt.tsx:1000` references it (read that file's dispatch helper and reuse it, do not invent a new command); (b) add a one-line steer input + submit that calls the existing prompt submit pipeline with `delivery: "steer"` for the selected tab's session ID (read `footer.prompt.tsx` submit path and `subagent-data.ts` for how the selected session ID is exposed; add a selector there only if the ID is not already reachable). No new keybind names unless the keymap module requires registration — if so, reuse `session.interrupt` for Stop and the composer's submit binding for Steer.
- **Test:** `bun typecheck` with `workdir` `packages/opencode`. **Expected:** exit 0.
- **Commit:** `feat(tui): add subagent stop and steer to inspector`.

### 8. Verify everything together

- **Action:** Run all three commands in order: `bun test src/pages/session/subagent-list-source.test.ts` (`packages/app`), `bun typecheck` (`packages/app`), `bun typecheck` (`packages/opencode`). Then regenerate nothing (no Protocol/Server `HttpApi` surface changed, so no `bun run generate` needed — state this in the commit body).
- **Test:** all three exit 0 / pass as above.
- **Commit:** none (verification only; the work is already committed per step).
