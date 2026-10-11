# Awake on User Hardware + Computer Use (Phases 3–4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the residues of report items 6 (RRULE routines), 10 (JSONL run mode), 12 (phone relay), and implement item 16 (computer use, tier (a) — in-app preview-pane actuator with per-action tiers, never self-approving).

**Architecture:** Gap-closing. Research (Oct 10, branch `codex-parity-build`) establishes: item 10 is already implemented end-to-end (two small residues: permission JSONL record; `retryCount` honored); item 12's relay exists (two residues: no `relayPublishUrl` writer; relay settings don't reach a running sidecar); item 6's scheduler/RRULE/run-record exist (residues: edit flow, runs endpoint, host targeting); item 16 has config/tool/guards/actuator but NO server→desktop executor bridge — built as a Question-shaped pending-request bridge with `WebContentsView` actuation (pane identity = preview partition), per-action tiers, screenshots via `captureView` (NOT `app:capturePage` — a composited view is not in the renderer capture).

**SCOPE RULING (controller, from research §2 of item 16):** tier (a) only — the in-app native preview pane is the sole actuator. OS-level pointer takeover is a written dead-end per the committed WS17 plan constraints ("no OS-wide pointer takeover, no new native input dependency") and the vendor framing (Codex foreground-seizure explicitly rejected). Recorded in ledger; surfaced in final docs.

**Tech Stack:** Effect-TS v4, SolidJS, Electron, Bun test, HttpApi codegen.

## Global Constraints

- Branch `codex-parity-build`; `dev` untouched until program end; tests from package dirs only; `bun typecheck` from package dirs; i18n en.ts + `flynncode-fallback.ts`; HttpApi changes ⇒ `bun run generate` from `packages/client` (never hand-edit generated); V1/V2 session-core rules (extra roots get watcher subscriptions WITHOUT Location nodes; placement keys untouched); conventional commits. Effect style throughout. Line anchors pre-remerge — re-anchor by symbols.

## Phase 3

### Task 1: Routine edit flow [item 6]

**Files:**
- Modify: `packages/app/src/components/settings-v2/routines-edit.ts` — add `updateRoutine(configFile?, id, patch: Partial<Pick<StoredRoutine, "name"|"rrule"|"dailyAt"|"interval"|"agent"|"directory"|"target">>)` (Flock-less, app-side; reuse `routinesToConfig` round-trip + `isValidRrule`)
- Modify: `packages/app/src/components/settings-v2/routines.tsx` — Edit button on rows opening the existing edit dialog pre-filled; Save applies `updateRoutine`
- Test: `packages/app/src/components/settings-v2/routines-edit.test.ts` (extend)
- i18n: `settings.routines.edit` + `.save` keys (en.ts + fallback)

- [ ] **Step 1: Write the failing test**

```ts
test("updateRoutine replaces one routine's schedule fields", () => {
  const before = fakeConfig([fakeRoutine({ id: "r1", name: "mornings", dailyAt: "09:00" })])
  const after = updateRoutine(before, "r1", { rrule: "FREQ=WEEKLY;BYDAY=MO" })
  expect(after.routines.r1.rrule).toBe("FREQ=WEEKLY;BYDAY=MO")
  expect(after.routines.r1.dailyAt).toBeUndefined()  // one-of constraint
  expect(after.routines.r1.name).toBe("mornings")
})
test("updateRoutine rejects an invalid rrule", () => {
  expect(() => updateRoutine(before, "r1", { rrule: "FREQ=" })).toThrow()
})
```

- [ ] **Step 2: FAIL. Step 3: Implement** (`updateRoutine` mirrors `addRoutine`'s precedence logic — rrule clears dailyAt/interval). **Step 4: PASS** (routines-edit + parity + inbox row tests). **Step 5: Commit** `feat(app): edit existing routines`.

### Task 2: Routine runs history endpoint [item 6]

**Files:**
- Modify: `packages/flynncode/src/plugin/routines/index.ts` — export `readRoutineRuns(file?)` (read jsonl via existing `parseRunRecords`, tail-capped)
- Modify: `packages/flynncode/src/server/routes/instance/httpapi/groups/global.ts` — `GET /global/routines/runs` (+ `routineId` query), success `Schema.Array(RunRecord)` mirroring `RoutineRun`; handler in `handlers/global.ts`
- Modify: `packages/app/src/components/settings-v2/routines.tsx` — history list prefers `serverSDK.client.global.routinesRuns({ query })`, falls back to embedded `recentRuns`; optionally inbox run counts
- Codegen: `bun run generate` from `packages/client`
- Test: extend plugin runs test (helper); handler-level test modeled on existing global handler tests (grep `test/server/httpapi-global*`)

- [ ] **Step 1:** failing handler test (runs jsonl with 3 records → endpoint returns array; `routineId` filters). **Step 2: FAIL. Step 3: Implement** (route + handler + export). **Step 4: PASS** + `bun run generate` diff inspected (+endpoint only). **Step 5: Commit** `feat(opencode): expose routine run history over HTTP` (+ app wiring in same or follow commit `feat(app): routine run history from the server`).

### Task 3: Deepthought (remote-host) targeting [item 6]

**Files:**
- Modify: `packages/flynncode/src/plugin/routines/parse.ts` — `Routine.target?: "local" | { url, username?, password? }`; `readTarget` validation (error style of `readRrule`)
- Modify: `packages/flynncode/src/plugin/routines/index.ts` — `runOne` builds/caches a per-target `createOpencodeClient({ baseUrl: target.url, headers: ServerAuth.headers({ username, password }) })` (precedent `plugin/index.ts:174–179`, `server/auth.ts:36–48`); `scheduler.active` status polls go to the TARGET client for targeted runs; unreachable host ⇒ existing error-run persistence (assert this in test)
- Modify: `packages/app/src/components/settings-v2/routines-edit.ts` — optional `target` carried through `routinesToConfig` + a host picker sourced from the servers list (`useServer().list`) when present
- Test: `packages/flynncode/test/plugin/routines/scheduler.test.ts` (extend — fakeClient keyed by base URL; offline host ⇒ error record in jsonl + recentRuns, lastRun advances)

- [ ] **Steps 1–5:** standard TDD loop. Commit `feat(opencode): target routines at a remote host` (+ app follow commit). **Security note:** credentials live in routine config (user-authored, local) — never render them in UI copy or logs; document in the settings row description.

### Task 4: Permission JSONL record in run [item 10 residue]

**Files:**
- Modify: `packages/flynncode/src/cli/cmd/run.ts` (`permission.asked` branch ~L840–860 — `emit("permission", { permission })` before the reply in BOTH auto and deny paths, json mode only)
- Test: `packages/flynncode/test/cli/run/run-process.test.ts` (extend — deny mode assertion: JSONL contains a `permission` record before `session_end`

- [ ] **Steps 1–5:** standard loop; commit `feat(cli): emit permission records in run json events`.

### Task 5: Honor `retryCount` for structured output [item 10 residue]

**Files:**
- Modify: `packages/flynncode/src/session/prompt.ts` (structured-output failure path ~L1423–1451/1444–1451 — instead of immediately breaking with `StructuredOutputError` retries:0, loop: on missing structured output with `retryCount > 0`, issue one more provider turn re-prompting for the StructuredOutput tool, bounded by the declared count; decrement-and-retain in the failure metadata)
- Test: `packages/flynncode/test/session/structured-output.test.ts` (extend — stub LLM replying with tool-less turn then a StructuredOutput turn ⇒ success after 1 retry; exhausted retries ⇒ StructuredOutputError with retries count)

- [ ] **Steps 1–5:** standard loop; commit `feat(opencode): retry structured output per format retryCount`. **Ruling if implementation balloon risk:** on BLOCKED, fall back to documenting the field inert (annotation + sdk.mdx note) — either way ledger the choice.

## Phase 3 (item 12)

### Task 6: Phone card relay URL field [item 12 residue #1]

**Files:**
- Modify: `packages/app/src/components/session/phone-card.tsx` (add a "Relay URL" row: text input + save via `window.api.storeSet(opencode.settings, "relayPublishUrl", value)` — the missing writer; reuse the deepthought-token paste pattern ~L91–98; display via `relayLauncherUrlFor` when unset)
- Modify: `packages/desktop/src/main/ipc.ts` / preload if `storeGet` for the field needs surfacing for display (mirror existing reads)
- i18n: `settings.phone.relayUrl.*` keys
- Test: extend `phone-card` source-contract tests (writer present; input persisted via storeSet)

- [ ] **Steps 1–5:** standard loop; commit `feat(app): relay URL field on the phone card`.

### Task 7: Live relay-config update [item 12 residue #2]

**Files:**
- Modify: `packages/desktop/src/main/sidecar-sync.ts` — add `relay-config` command variant (mirror `sync-config`: `{ token, remoteToken, url }`, `SidecarSyncCommand` union)
- Modify: `packages/desktop/src/src/sidecar.ts` (`sidecar.ts:46,302–313,407–414`) — handle the command: stop/rebuild/start the relay publisher live (reuse `startRelayPublisher`'s stop path); phone-card token/url writers trigger it after store writes
- Test: `packages/desktop/src/main/sidecar-sync.test.ts` (extend — relay-config round-trip rebuilds publisher)

- [ ] **Steps 1–5:** standard loop; commit `feat(desktop): live relay publisher updates without restart`. **Graceful degradation unchanged:** unreachable relay stays warn-and-retry (already tested).

## Phase 4 — Computer use (tier (a))

### Task 8: Executor bridge — schema, service, HttpApi, renderer [item 16]

**Files:**
- Create: `packages/schema/src/v1/computer-use.ts` — `ComputerUse.Requested` event schema (`{ requestID, sessionID, action, appID, args: {x?,y?,text?,key?,deltaX?,deltaY?}, time }`) + reply types
- Create: `packages/flynncode/src/computer-use/index.ts` — `ComputerUseExecutor` Question-shaped service (`packages/flynncode/src/question/index.ts` is the template: pending `Map<RequestID, {request, defer}>` in InstanceState-shaped state, `Effect.serviceOption` availability, `execute(request)` = publish `Event.ComputerUse.Requested` via EventV2Bridge + `Deferred.await` with a SHORT timeout (e.g. 10s) → `ComputerUseExecutorUnavailableError`; `reply(requestID, result)` resolves)
- Modify: `packages/flynncode/src/server/routes/instance/httpapi/groups/computer-use.ts` (create) — `GET /computer-use/requests` (list pending)? NO — phone/dock not involved; keep minimal: `POST /computer-use/execute/reply` + `GET /computer-use/requests` for the desktop listener bootstrap; handler in `handlers/computer-use.ts` (create)
- Modify: `packages/flynncode/src/api.ts` / protocol registration + `packages/flynncode/src/server/routes/instance/httpapi/server.ts` (mount group; mirror how question group mounts)
- Codegen: `bun run generate` from `packages/client`
- Modify: `packages/app/src/context/platform` consumer chain (desktop-gated listener: platform === "desktop", native preview flag on) — subscribes to the event, executes via `window.api.computerUse.*` / `window.api.previewHost.capture()`, POSTs the reply
- Test: `packages/flynncode/test/computer-use/executor.test.ts` (new — pending map, Deferred, publish/subscribe roundtrip via EventV2Bridge test helpers, timeout→Unavailable, reply→resolution; `pollWithTimeout` style, no fixed sleeps)

- [ ] **Step 1: Write the failing service test**

```ts
it.effect("executes via the bridge when a client replies", () =>
  Effect.gen(function* () {
    // fork execute(screenshot request); expect Event.ComputerUse.Requested published
    // (assert via EventV2Bridge subscribe); reply with screenshot result; deferred resolves;
    // ExecuteResult.ok === true with png dataUrl.
  }))
it.effect("times out to ComputerUseExecutorUnavailableError when no client answers", () =>
  Effect.gen(function* () {
    // publish-only fiber, no reply; inject a tiny timeout for testability
    // assert: failure is ComputerUseExecutorUnavailableError (honest "not performed")
  }))
```

(Assemble from the Question-service test shape — `packages/flynncode/test/question/` or wherever its tests live; pollWithTimeout style, no fixed sleeps.)

- [ ] **Steps 2–5:** standard loop; commit `feat(opencode): computer-use executor bridge (question-shaped)`.

**Interfaces (locked for Task 9):** `ComputerUseExecutor.Service = { execute(request: ExecuteRequest): Effect<ExecuteResult, ComputerUseExecutorUnavailableError>; reply(requestID: string, result: ExecuteResult | { error: string }): Effect<void> }`; `ExecuteResult = { ok: true, screenshot?: string, output?: string } | { ok: false, error: string }`.

### Task 9: Tool wiring + per-action tiers + appID vocabulary [item 16]

**Files:**
- Modify: `packages/flynncode/src/tool/computer-use.ts` — order: config resolve (enabled/allowlist fail-closed, unchanged) → `executor` availability probe (before ask — preserves fail-before-ask honesty; `ComputerUseExecutorUnavailableError` + honest "not performed" text when absent) → `ctx.ask({ permission: "computer_use", patterns: [appID, action], metadata: { action, appID }, always: [] })` → executor dispatch → screenshot action returns `attachments: [{ type: "file", mime: "image/png", url: dataUrl }]` (captureView source); rejection/timeout ⇒ honest failure text
- Modify: `packages/core/src/v1/config/config.ts` + `packages/flynncode/src/config/computer-use.ts` — extend `ComputerUsePolicy` with optional per-action tiers: `tiers?: { observe?: { enabled?: boolean }, mutate?: { enabled?: boolean } }` — `observe` gates `screenshot`, `mutate` gates `click|type|keypress|scroll`; tiers TIGHTEN only (a disabled tier fails closed BEFORE ask; unknown tier keys tolerated-fail-closed); consent stays at the human (ALWAYS_ASK) — `appID` vocabulary: reserved pseudo-app id `flynncode:browser-pane` (documented in tool txt + consent copy; exact-match)
- Modify: `packages/flynncode/src/tool/computer-use.txt` (description: pane-scoped semantics, the reserved app id, tier gating, never-self-approving note)
- Test: `packages/flynncode/test/tool/computer-use.test.ts` (extend — ask recorded with `[appID, action]` once executor available; unavailable ⇒ fail BEFORE ask (`asked` array empty); tier disabled ⇒ fail before ask; screenshot attachment present)
- Test: extend `test/permission/computer-use-guard.test.ts` (tier-map semantics)

- [ ] **Steps 1–5:** standard loop; commit `feat(opencode): wire computer-use tool to the executor with action tiers`.

### Task 10: Desktop side — pane identity + allowlist semantics [item 16]

**Files:**
- Modify: `packages/desktop/src/main/computer-use.ts` — re-point `paneFor` at the `preview` partition identity (mirror `previewViewFor` from `preview-host.ts`; move/share the helper so only the preview view is ever driven); add `screenshotPane(win)` via `captureView`
- Modify: `packages/app/src/components/session/computer-use-menu.tsx` — surface the reserved app id + tier gating in the allowlist UI (checkbox for `flynncode:browser-pane` + observe/mutate toggles; save path unchanged: config first, desktop store mirror)
- Test: `packages/desktop/src/main/computer-use.test.ts` (extend — partition-identity matcher with injected child views; screenshotPane pure helpers)
- Test: extend app source-contract suite (`computer-use-panel.test.ts`) for the menu wiring

- [ ] **Steps 1–5:** standard loop; commit `feat(desktop): drive the preview pane as the computer-use actuator`.

### Task 11: Computer-use documentation + trust-boundary disclosure [item 16 + T3 promoted]

**Files:**
- Create: `packages/web/src/content/docs/computer-use.mdx` (+ sidebar registration in `astro.config.mjs`): semantics (pane-scoped, tier (a)), enable flow (config + desktop mirror), per-action tiers, consent model (never self-approving, ALWAYS_ASK, no "allow always"), the reserved app id, screenshots via the preview view, **flag-on trust boundary** (native view trusts the loopback page more than the iframe: guest `window.open` unguarded, subframe nav/fetch unguarded — the promoted T3 follow-up, written as known limitations), OS-level tier explicitly out of scope and why
- Verify every claim against source before writing (tool/computer-use.ts, computer-use service, ipc.ts, menu)

- [ ] Commit `docs(web): computer-use reference`.

## Deferred (documented; consistent with prior phases)

- OS-level input tier (item 16 tier b) — dead-end per committed constraints; revisit only with a new spec.
- `--allowed-tools` headless flag (item 10) — config `permission` map covers it.
- `--resume` naming alias (item 10) — `--session` documented instead.
- part-delta JSONL streaming (item 10) — additive later if CI consumers need it.
- machine-sync enhancements (item 12) — separate subsystem, unchanged.

## Verification (phase gate)

```bash
# packages/flynncode: bun typecheck; bun test ./test/computer-use/ ./test/tool/ ./test/session/ ./test/cli/ ./test/permission/ ./test/plugin/routines/
# packages/core: bun typecheck + agent-config/command tests
# packages/app: bun typecheck; bun run test:unit
# packages/desktop: bun typecheck; bun test ./src/main/
# packages/client (codegen steps): bun run generate + typecheck
```

Manual smoke: routine edit/rrule + history endpoint + targeted run against an offline host (fail path only — no live remote host here); run --json permission record; retryCount behavior; phone card relay URL + live publisher update (desktop only); computer-use tiers + consent card + screenshot (desktop, native flag on).