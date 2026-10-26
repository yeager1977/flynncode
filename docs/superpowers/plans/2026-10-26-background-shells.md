# Background Shells Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Flynncode agent run shell commands in the background, read their output later, stop them, and be woken when output matches a pattern or the process exits — like Claude Code's `run_in_background`, BashOutput, KillShell and Monitor — without ever leaving orphaned processes.

**Architecture:** A GLOBAL (not instance-scoped) `BackgroundShells` service in `packages/flynncode/src/shell/background/` owns every background process in its own long-lived scope, keyed by session. Pure helpers handle the capped output file (`output.ts`) and the crash-recovery PID registry (`registry.ts`). The `bash` tool gains `run_in_background`; new tools `bash_output`, `kill_shell`, `monitor` call the service. Notifications reuse the background-subagent path (`ctx.extra.promptOps.prompt` with a synthetic text part, `delivery: "queue"`). Lifecycle: kill on session delete/archive (event subscription), on server stop (layer finalizer), at the time cap, and leftovers from crashes on startup. New `shell.background.*` events and two HTTP routes feed an app chip + panel.

**Tech Stack:** TypeScript, Effect 4 beta (`ChildProcessSpawner`/`AppProcess` from `@flynncode/core/process`, `ChildProcess` from `effect/unstable/process`), bun test, SolidJS app, legacy SDK regen (`./packages/sdk/js/script/build.ts`).

**Spec:** `docs/superpowers/specs/2026-10-26-background-shells-design.md`

## Global Constraints

- Names: tool param `run_in_background`; tools `bash_output { id, filter? }`, `kill_shell { id }`, `monitor { id, pattern, timeout? }`. Shell ids `bash_<ascending id>`.
- Statuses: `running` | `exited` (with `exitCode`) | `killed` | `timed_out`.
- Time cap: default and maximum `shell.backgroundMaxMs` = 7_200_000 (2 h); `timeout` on a background call is clamped to it.
- Kill: SIGTERM to the process group (`process.kill(-pid, "SIGTERM")`), SIGKILL after 5 s if alive.
- Limits: 8 running background shells per session; 4 active monitors per session. Monitor default timeout 600_000 ms, max 1_800_000 ms.
- Output file: under `Global.Path.data/tool-output/` named `tool_<ascending>` (so the existing 7-day Truncate cleanup covers it). The service opens writers with an 8 MiB cap (writer default 50 MiB): the first 1 MiB (head) stays in the file plus a rolling tail (≈7 MiB held in memory per running shell); reads use the writer's logical stream (1 MiB window), never the file, and report `truncated: true` once the cap is hit. Filtered reads stop at the last complete line so split matches are not lost.
- Exit notification: shell id, command, status, last 20 lines.
- Notifications: `ops.prompt({ sessionID, parts: [{ type: "text", synthetic: true, text }], delivery: "queue" })` via `ctx.extra.promptOps` captured at tool-call time (see `packages/flynncode/src/tool/task.ts` `inject`/`notify`). A failure to notify never affects the shell.
- Background shells are NOT cancelled by the user pressing Stop on a session (`SessionRunState.cancel` → `cancelBackgroundJobs` matches `metadata.parentSessionId/sessionId`) — the service is separate from `BackgroundJob`.
- Registry: a directory `path.join(Global.Path.state, "background-shells")` with one file per server process, `<pid>-<starttime>.json` (start time = `/proc/<pid>/stat` field 22, or `t<Date.now()>` without /proc), because several servers (desktop sidecar, CLI/TUI, dev servers) share `Global.Path.state`; a server only writes its own file. Entries `{ id, sessionID, pgid, start, startedAt, command }`: a group is identified by (pgid, start), where `pgid` is the leader's pid (it leads its own group because it is spawned detached) and `start` is the leader's `/proc/<pid>/stat` field 22, read immediately after spawn (it exists as soon as the process does, so there is no exec race; if the leader has already exited, the earliest surviving member's start time); `command` is informational only. Without /proc nothing is recorded (debug log). Startup cleanup only reads files of dead owners (pid gone or start time differs) and kills a recorded group only if it is still the same group: the leader pid is alive with the same start time, or the leader is gone and processes with `pgrp === pgid` and their own start time ≥ `start` exist (a pgid cannot be reused while any member of the group exists, and later processes cannot predate the group). A leader pid with another start time and no matching members means the pid was recycled → skip (resolved); on platforms without /proc nothing can be verified → skip (do nothing).
- Permissions: `run_in_background` goes through exactly the existing `bash` permission (`ctx.ask` with `permission: "bash"`) and sandbox checks. `bash_output`/`kill_shell`/`monitor` act only on shells of `ctx.sessionID`; add them to `Permission.disabled`'s tool→permission map as `"bash"` so a `bash: deny` rule hides them.
- Events: `shell.background.started { sessionID, id, command, pid, startedAt }`, `shell.background.output { sessionID, id, bytes, tail }` (throttled to ≤ 1 per second per shell; `bytes` = `writer.total()`; `tail` = last 4 KiB), `shell.background.exited { sessionID, id, status, exitCode? }`.
- Repo style (AGENTS.md): no `any`, no import aliases or star imports, `const` over `let` where practical, no `else`, bind Effect services to variables, comments only for non-obvious constraints, self-export pattern. Tests from package dirs; `bun typecheck` from package dirs. Never write your own files under `/tmp`; if test temp space is needed set `TMPDIR=/home/yeager1977/GitHub/flynncode/.git/sdd/tmp` and delete it afterwards. Leave no test or child processes running.
- Shared checkout: stage explicit paths only; never `git add -A`; never `git stash`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Capped output file

**Files:**
- Create: `packages/flynncode/src/shell/background/output.ts`
- Create: `packages/flynncode/test/shell/background-output.test.ts`

**Interfaces:**
- Produces:
  - `BackgroundOutput.open(file: string, input?: { capBytes?: number; headBytes?: number; windowBytes?: number; flushMs?: number }): Writer` where `Writer = { write(chunk: string): void; readSince(offset, input?): { text; offset; skipped }; lastLines(count: number): string; total(): number; truncated(): boolean; pendingBytes(): number; close(): Promise<void> }`.
  - Readers never read the file. The writer keeps a LOGICAL stream position (`total()` = bytes ever written) and an in-memory read window of the newest `windowBytes` (default 1 MiB).
  - `writer.readSince(offset: number, input?: { filter?: RegExp; maxBytes?: number }): { text: string; offset: number; skipped: number }` — `offset` is a logical position (0 = start). Bytes older than the window, plus bytes clipped by `maxBytes` (default 50 KiB, keeps the newest), are reported in `skipped`, with a `...[N bytes skipped]...` prefix only when the (filtered) text is non-empty or no filter is set. `filter` is applied line by line. Returns `offset = total()` regardless of filtering. A clipped start never splits a UTF-8 character.
  - `writer.lastLines(count)` reads from the window (`count <= 0` → `""`). The window stays readable after `close()`; the service keeps the writer until the session ends.
  - The FILE is persistence / "open full output" only. `open()` truncates or creates it. Synchronous `write` queues bytes that are appended in order (one serialized chain). Once `total()` exceeds `capBytes` (default 50 MiB) the file becomes head (first `headBytes`, default 1 MiB) + marker line `\n...[output truncated: N bytes dropped]...\n` + rolling tail (`capBytes - headBytes`, held in memory). Rewrites are atomic (`writeFile(<file>.tmp)` + `rename`). They happen immediately when the cap is first crossed, then at most every `flushMs` (default 5 s), with an unref'd trailing-edge timer so a quiet burst still reaches the file. `close()` does a final flush.
  - Bounded memory: if queued-but-unwritten bytes exceed `capBytes` (stalled disk), the oldest are dropped and counted in the marker. Disk errors are swallowed and never affect the shell.

- [ ] **Step 1: Failing tests** (real files in the repo's tmpdir fixture): logical offsets keep working across the cap (`skipped` correct when behind the window); `filter` advances the offset fully and prefixes skips only with text; `maxBytes` keeps the newest bytes; clipped reads never split UTF-8; `lastLines(20)` and `lastLines(0) === ""`; cap: with `capBytes: 1000, headBytes: 200`, writing 5000 bytes leaves a file of ≤ 1100 bytes with the first 200 bytes, the marker and the last bytes; atomic rewrites (polling readers never see a partial or mixed file); the trailing timer flushes a quiet burst; a failing disk keeps `pendingBytes()` ≤ `capBytes`.
- [ ] **Step 2:** `cd packages/flynncode && bun test test/shell/background-output.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement with `node:fs/promises` (`appendFile`, `writeFile`, `rename`, `readFile`). Self-export `export * as BackgroundOutput from "./output"`.
- [ ] **Step 4:** tests pass; `bun typecheck`.
- [ ] **Step 5: Commit** `feat(flynncode): add a capped output file for background shells`

---

### Task 2: Crash-recovery PID registry

**Files:**
- Create: `packages/flynncode/src/shell/background/registry.ts`
- Create: `packages/flynncode/test/shell/background-registry.test.ts`

**Interfaces:**
- Produces:
  - `type Entry = { id: string; sessionID: string; pgid: number; start: string; startedAt: number; command: string }`
  - `BackgroundRegistry.owner(): Promise<{ pid: number; start: string }>` — the current process (memoized).
  - `BackgroundRegistry.add(dir: string, entry: Entry): Promise<void>`, `remove(dir: string, id: string): Promise<void>`, `list(dir: string): Promise<Entry[]>` — act only on the current owner's file `<dir>/<pid>-<start>.json`: JSON array, written atomically (temp file + rename), serialized through an in-process promise chain so concurrent adds/removes don't lose entries. `list` reads a missing or unreadable file as `[]` (log nothing here); `add`/`remove` fail rather than overwrite a file they could not read (anything other than ENOENT, including unparsable content).
  - `BackgroundRegistry.groupStart(pgid: number): Promise<string | undefined>` — the leader's `/proc/<pgid>/stat` field 22; if the leader is gone, the minimum start time of processes whose `pgrp === pgid`; `undefined` without /proc or when the whole group is gone.
  - `BackgroundRegistry.reap(dir: string, input?: { kill?: (pgid: number, signal: NodeJS.Signals) => void }): Promise<{ killed: Entry[]; skipped: (Entry & { reason: string })[] }>` — for every OTHER owner file whose owner is dead (pid not alive, or its /proc start time differs from the name; the current pid with another start time counts as dead), process each entry: skip pgid ≤ 1 and groups that are no longer the recorded one (resolved; see the Registry constraint for the (pgid, start) check); never signal a pgid equal to self or parent, or the current process group (unresolved); a matching pid that leads no group (`kill(-pgid, 0)` fails) is skipped (resolved). Otherwise SIGTERM the group (`-pgid`) and treat it as alive while `process.kill(-pgid, 0)` does not fail with ESRCH; SIGKILL the group after 2 s → `killed`. An error on one entry (e.g. EPERM) is recorded in `skipped` with the reason and the sweep continues. The dead owner's file is deleted only when every entry was resolved; otherwise it is rewritten with the unresolved entries for the next start. Live owners' files are never touched. Default `kill` = `(pgid, sig) => process.kill(-pgid, sig)` with ESRCH ignored.

- [ ] **Step 1: Failing tests:** add/list/remove round-trip; concurrent adds keep all entries; corrupt file → `list` returns `[]`; `reap` with a real `sleep 60` started `detached: true` via `node:child_process` spawn and recorded with its real start time → killed (process gone); a leaderless group (`sh -c 'sleep 300 >/dev/null 2>&1 &'`, leader exited) → the member is killed; a live detached `sleep 60` recorded with a wrong start time (recycled pid) → skipped and the process untouched; registry empty after reap.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** pass + typecheck.
- [ ] **Step 5: Commit** `feat(flynncode): record background shell process groups for crash cleanup`

---

### Task 3: The BackgroundShells service

**Files:**
- Create: `packages/flynncode/src/shell/background/service.ts`
- Create: `packages/flynncode/test/shell/background-service.test.ts`
- Modify: `packages/flynncode/src/server/routes/instance/httpapi/server.ts` (register the node in the `app` LayerNode group)

**Interfaces:**
- Consumes: `BackgroundOutput`, `BackgroundRegistry`, `AppProcess.Service` (`@flynncode/core/process`), `ChildProcess` (`effect/unstable/process`), `Global.Path`, `TRUNCATION_DIR` (`packages/flynncode/src/tool/truncation-dir.ts`), `ToolID`-style ascending ids (see `packages/flynncode/src/tool/truncate.ts` for how `tool_<ascending>` names are made).
- Produces (`BackgroundShells.Service`):
  - `type Status = "running" | "exited" | "killed" | "timed_out"`
  - `type Shell = { id: string; sessionID: string; command: string; pid: number; outputPath: string; startedAt: number; status: Status; exitCode?: number; endedAt?: number }`
  - `start(input: { sessionID: string; command: string; cwd: string; env: Record<string, string>; shell: string; timeoutMs?: number; notify?: (text: string) => Effect.Effect<void> }): Effect<Shell, ShellLimitError>` — refuses when the session already has 8 running.
  - `read(input: { sessionID: string; id: string; filter?: string }): Effect<{ shell: Shell; output: string; truncated: boolean } | undefined>` — output since this caller's previous read, via `writer.readSince` with a per-shell LOGICAL offset kept in the service (never a file offset); `truncated` is `writer.truncated()`; invalid regex → fails with a typed error.
  - `output(input: { sessionID: string; id: string; offset: number }): Effect<{ text: string; offset: number; skipped: number; truncated: boolean } | undefined>` — `writer.readSince` from a caller-supplied logical offset, for the Task 6 route; never touches the agent's read offset.
  - `kill(input: { sessionID: string; id: string }): Effect<Shell | undefined>`
  - `monitor(input: { sessionID: string; id: string; pattern: string; timeoutMs?: number; notify: (text: string) => Effect.Effect<void> }): Effect<void, MonitorError>` — validates regex, enforces 4 monitors/session, returns immediately; fires `notify` once on first matching NEW line, on exit, or on deadline.
  - `list(sessionID: string): Effect<Shell[]>`, `killSession(sessionID: string): Effect<number>` (count killed), `killAll(): Effect<void>`.
- Behavior:
  - Spawn with `ChildProcess.make(input.command, [], { shell: input.shell, cwd: input.cwd, env: input.env, stdin: "ignore", detached: process.platform !== "win32" })` via `AppProcess.Service.spawn` into the SERVICE'S long-lived scope (pattern: `packages/flynncode/src/preview/preview.ts` ~195-205 and 273 — `Effect.provideService(Scope.Scope, scope)`), never the tool's scope.
  - Stream `handle.all` (decoded text) into the `BackgroundOutput` writer; the exit notification uses `writer.lastLines(20)`. Keep each shell's writer (and its read window) until the session's shells are dropped.
  - Record the entry in the registry right after spawn with `pgid` = the leader pid and `start` = `BackgroundRegistry.groupStart(pid)` (no polling; always written on Linux while the group exists, including a leader that exits at once and leaves members behind); without a start time (no /proc) skip with a debug log; remove it once the whole group is gone.
  - Race exit vs the time cap (`min(timeoutMs ?? cap, cap)`, cap from config `shell.backgroundMaxMs` default 7_200_000): on cap → kill group (SIGTERM, SIGKILL after 5 s), status `timed_out`.
  - On exit (any reason other than an explicit `kill`), call `notify` with the exit summary (id, command, status/exit code, last 20 lines). Notify failures are caught and logged.
  - Publish `shell.background.*` events in Task 6 — leave a single internal `emit(event)` hook now (no-op) so Task 6 only fills it in.
  - Layer finalizer: `killAll()`. On layer start: `BackgroundRegistry.reap(registryDir)` (log counts).
  - `node = LayerNode.make({ service, layer, deps: [AppProcess.node, Config.node?] })` — check how to read config (`shell.backgroundMaxMs`) the way other global services do; if config is instance-scoped, take the cap as a `start` input from the tool instead (the tool has instance config) and document it.
- [ ] **Step 1: Failing tests** (real processes; build the layer like `packages/flynncode/test/storage/session-diff-sweep.test.ts`):
  1. start `sleep 0.2; echo done` → returns `running` at once; after ~1 s `read` shows `done`, status `exited`, exitCode 0; `notify` was called once with text containing the id and `done`.
  2. start `sh -c 'sleep 60 & sleep 60'` → `kill` → status `killed`; no process remains in the group (`process.kill(-pid, 0)` throws ESRCH within 6 s).
  3. `timeoutMs: 300` on `sleep 30` → status `timed_out`, notify called.
  4. 9th concurrent start in one session → `ShellLimitError`; another session can still start.
  5. `read` twice returns only new output the second time; `filter` keeps matching lines only.
  6. `monitor` with pattern `ready` on `sleep 0.2; echo ready; sleep 5` → notify once with the line; invalid regex → `MonitorError`; deadline 300 ms with no match → notify with "pattern not seen"; a 5th monitor in a session → error.
  7. `killSession` kills only that session's shells; layer close (scope close) kills all (no surviving pids).
  8. registry: a started shell appears in this server's registry file (`BackgroundRegistry.list(registryDir)`); after exit it is removed.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement; register the node. **Step 4:** pass; `bun typecheck`; `bun test test/server/httpapi-cors.test.ts` (app boots). Ensure no stray processes after the test run (`pgrep -f "sleep 60"` empty).
- [ ] **Step 5: Commit** `feat(flynncode): add a session-bound background shell service`

---

### Task 4: Agent tools

**Files:**
- Modify: `packages/flynncode/src/tool/shell/prompt.ts` (add `run_in_background: Schema.optional(Schema.Boolean)` with a description that says it returns immediately with a shell id, the process is stopped when the session ends or after the time cap, and to use `bash_output`/`monitor`/`kill_shell` with the id)
- Modify: `packages/flynncode/src/tool/shell.ts` (when `run_in_background` is true: same permission/sandbox `ask()` path as foreground, then `BackgroundShells.start(...)` with the resolved shell/cwd/env and a `notify` built from `ctx.extra.promptOps` exactly like `task.ts`'s `inject` but with `delivery: "queue"`, forked into the tool layer's scope; return `{ title: "started in background", metadata: { background: true, shellId, pid, outputPath }, output: "<id> started (pid …). Output: <path>. Use bash_output with this id …" }`; interactive + background together → error result)
- Create: `packages/flynncode/src/tool/bash-output.ts`, `kill-shell.ts`, `monitor.ts` (+ `.txt` descriptions next to them, following existing tool files)
- Modify: `packages/flynncode/src/tool/registry.ts` (register the three tools next to `bash`; same client/flag gating as `bash`)
- Modify: `packages/flynncode/src/permission/index.ts` (`Permission.disabled` map: `bash_output`, `kill_shell`, `monitor` → `"bash"`)
- Modify: `packages/flynncode/test/tool/__snapshots__/parameters.test.ts.snap` if the parameters snapshot test covers bash (update via the test's normal snapshot update flow)
- Test: `packages/flynncode/test/tool/background-shell-tools.test.ts`

**Interfaces:**
- Consumes: `BackgroundShells.Service` (Task 3).
- [ ] **Step 1: Failing tests** — mirror existing tool tests (e.g. `test/tool/task.test.ts` / shell tool tests: find how they build a tool context with `promptOps`). Cases: background start returns the id and the process runs; `bash_output` returns output + status; `kill_shell` stops it; `monitor` registers and the injected prompt arrives through `promptOps.prompt` with `delivery: "queue"` and a synthetic text part; unknown id → "no such background shell" (not a throw); a `bash` deny rule for the command pattern also denies `run_in_background`; `Permission.disabled` hides the three tools when `bash` is denied.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `bun test test/tool` + `bun typecheck`.
- [ ] **Step 5: Commit** `feat(flynncode): let the agent run, read, monitor and kill background shells`

---

### Task 5: Lifecycle — session delete/archive

**Files:**
- Modify: `packages/flynncode/src/shell/background/service.ts` (subscribe to session deleted / archived events and call `killSession`)
- Test: add cases to `packages/flynncode/test/shell/background-service.test.ts` or a new `background-lifecycle.test.ts`

**Interfaces:**
- Consumes: the session event stream. Follow `packages/flynncode/src/share/share-next.ts` ~167-212 (`events.listen(...)` + `Effect.addFinalizer` unsubscribe) — but subscribe globally (the service is global), matching `SessionV1.Event.Deleted` and `SessionV1.Event.Updated` where `info.time.archived` is set. Also cover machine-sync archive (it emits its own `session.updated`). If a global (non-instance) subscription API is not available, use `GlobalBus.on("event", …)` the way `machine-sync/store.ts` ~127-151 tracks `session.status`.
- [ ] **Step 1: Failing tests:** start a shell in session S, publish/perform a delete of S (use the real Session service where practical) → shell killed; archive S → killed; a shell in another session survives.
- [ ] **Step 2–4:** run → FAIL → implement → pass + typecheck.
- [ ] **Step 5: Commit** `feat(flynncode): stop background shells when their session is deleted or archived`

---

### Task 6: Events, routes and SDK

**Files:**
- Create: `packages/schema/src/shell-background.ts` (events via `Event.define` like `packages/schema/src/pty.ts` ~33-37)
- Modify: `packages/schema/src/event-manifest.ts` (register in `Definitions`)
- Modify: `packages/flynncode/src/shell/background/service.ts` (fill in `emit` using `EventV2Bridge.Service.publish` or the global equivalent the bridge uses — events need the session's directory for routing; store `directory` on each shell from the tool call)
- Create: `packages/flynncode/src/server/routes/instance/httpapi/groups/background-shells.ts` + `handlers/background-shells.ts` (instance-scoped group, like `groups/pull-request.ts`): `GET /session/{sessionID}/shells` → `Shell[]`; `GET /session/{sessionID}/shells/{id}/output?offset=` → `{ text, offset, skipped, truncated }` (`offset` is a logical stream position; reads via `BackgroundShells.output`, does NOT advance the agent's read offset); `POST /session/{sessionID}/shells/{id}/stop` → `Shell`. Same middleware as other instance groups (Authorization).
- Modify: `packages/flynncode/src/server/routes/instance/httpapi/api.ts` + `server.ts` (register group + handlers)
- Modify: `packages/flynncode/test/server/httpapi-exercise/index.ts` (scenarios for the three routes, incl. protected/unauthenticated probes, like the worktree-cleanup ones)
- Regenerate: `./packages/sdk/js/script/build.ts`
- Test: `packages/flynncode/test/server/background-shells-httpapi.test.ts`
- [ ] Steps: failing route test → implement → `bun test` route test + `bun run test:httpapi` (report pre-existing failures separately; 23 unrelated routes were already missing scenarios) → typecheck flynncode, schema, sdk/js, app → regenerate SDK (stage only files changed by these routes/events) → commit `feat(flynncode): publish background shell events and routes`

---

### Task 7: App — chip, panel, transcript

**Files:**
- Create: `packages/app/src/context/background-shells.ts` (or a hook `packages/app/src/hooks/use-background-shells.ts`): per-session shell list from the SDK `GET` route + live updates from the three events (subscribe like `pages/session/usage-exceeded-dialogs.tsx:54` / `sdk().event.on(...)`), keyed by shell id.
- Modify: `packages/app/src/components/session/session-header.tsx` (chip "⚙ N running" when N > 0, next to the tasks toggle ~l.861; clicking opens the panel)
- Modify: `packages/app/src/pages/session/session-side-panel.tsx` (a "Background shells" section next to `<SubagentList>` ~942-966): rows with command, elapsed, status, live tail (fetch output via the route with offset; cap 200 lines), Stop button (POST stop), "Open full output" (open the output path the same way other file links open)
- Modify: `packages/session-ui/src/components/message-part.tsx` (shell renderer ~2091-2159: when `metadata.background` is true render the compact "started in background: `<command>` · <id>" card; render synthetic background-shell notifications compactly if they are identifiable — e.g. by a recognizable prefix the tool uses)
- Modify: sidebar row badge (find the session row in `packages/app/src/pages/layout/session-sidebar.tsx`) — small "⚙" marker when the session has running shells (only if the data is cheaply available from the store; otherwise skip and note it)
- Modify: i18n `packages/app/src/i18n/en.ts` + `flynncode-fallback.ts` (and `packages/ui/src/i18n/*` only if the strings live there)
- Test: `packages/app/test-browser/background-shells.test.ts` — pure helpers: reducer applying started/output/exited events to a list; elapsed formatting; tail clipping to 200 lines.
- [ ] Steps: failing browser test → implement → browser suite + `bun test --isolate --conditions=solid --preload ./happydom.ts src/i18n` + typecheck (app, session-ui) → prettier on touched files → commit `feat(app): show and stop background shells`

---

### Task 8: Promote a running foreground shell (optional — descope if invasive)

**Files:** `packages/flynncode/src/tool/shell.ts`, `packages/flynncode/src/shell/background/service.ts`, `packages/session-ui/src/components/message-part.tsx`, tests.

The foreground `bash` path spawns inside the tool's scope. Promotion requires the process to live in the service's scope. Approach: add `BackgroundShells.adopt({ sessionID, handle, command, outputPath, notify })` only if the spawner handle (and its output stream) can be handed from the tool's scope to the service's scope without killing the process (check `packages/core/src/cross-spawn-spawner.ts` release semantics). Evaluate this first. If adoption requires restructuring the foreground path (e.g. spawning every foreground command in the service), STOP and report BLOCKED with a short design note (options + trade-offs) instead of forcing it; the controller will descope promotion. The app "Move to background" button is part of this task.

- [ ] Steps: investigate → (implement + tests | report BLOCKED) → commit `feat(flynncode): move a running shell to the background`

---

### Task 9: Spec sync and verification

- [ ] Update `docs/superpowers/specs/2026-10-26-background-shells-design.md` where the implementation differs (e.g. promote descoped, config source of the cap).
- [ ] Run: `cd packages/flynncode && bun test test/shell test/tool test/server/background-shells-httpapi.test.ts test/server/httpapi-cors.test.ts && bun typecheck`; `cd packages/app && bun test --conditions=browser --preload ./happydom.ts ./test-browser && bun typecheck`; check `pgrep -fa "sleep 60"` is empty afterwards. Classify failures (pre-existing vs new) without `git stash`.
- [ ] Commit the spec only: `docs: sync background shells spec with the implementation`
