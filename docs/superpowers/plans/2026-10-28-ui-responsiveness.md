# UI Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop app feel as responsive as Claude's. That means removing the measured stalls in startup, session open/switch, streaming, history scrolling and typing.

**Architecture:** Six independent groups of targeted fixes, ordered by measured impact. Each group is re-measured with the investigation harness.

**Tech Stack:** TypeScript, SolidJS, Effect 4 beta, Electron (electron-vite), bun test, Playwright perf e2e.

**Spec:** `docs/superpowers/specs/2026-10-28-ui-responsiveness-design.md`
**Evidence:** `.git/sdd/perf-investigation.md`, which has file:line evidence per finding F1–F8.
**Harness:** `.git/sdd/perf-harness/`. Start it with `start.sh`, then run `bun bench.ts startup|switch|typing|scroll|stream|stream2 4` and `bun trace.ts stream-short 1`.

## Global Constraints

**Goals**, measured with the harness on a sandbox copy of the owner's DB:
- Composer ready and direct session open at least 1 s sooner.
- No `/provider` call blocking other requests, and no 5-minute stalls.
- No long task over 100 ms while streaming in the longest session at 4× CPU.
- Main-thread busy time while streaming down by 30% or more.
- No frame over 100 ms when paging history.
- Typing p95 at or below 25 ms while streaming at 4×.
- No session-switch long task over 60 ms.
- The desktop window shows before the sidecar has loaded.

**Behaviour:** identical apart from timing. The full provider catalog stays available on demand.

**Measurement:**
- Each task records before/after harness numbers in its report.
- Harness runs use a SANDBOX copy of the DB under `$HOME/.cache/flynncode-perf/`.
- Never touch the owner's running app, data or config.
- Never write to `/tmp`.

**Repo style (AGENTS.md):**
- No `any`, no import aliases or star imports.
- `const` over `let`, no `else`.
- Comments only for non-obvious constraints.
- Prefer functional array methods.
- Tests run from package dirs and avoid mocks.
- `bun typecheck` runs from package dirs.
- Use `TMPDIR=$HOME/.cache/flynncode-test-tmp`, and don't delete dirs you didn't create.
- Leave no processes running.

**Shared checkout:**
- Stage explicit paths only.
- Never `git add -A`, `git stash`, `git checkout` or `git worktree prune`.
- Leave `packages/flynncode/src/plugin/ollama-cloud.ts`, `.debbuild.log` and `.opencode/memories/*` alone.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Provider catalog (F1)

- **Server:**
  - Cache the serialized provider list per config/auth/catalog revision and serve it with an ETag (304 when unchanged).
  - Build it off the request path.
  - Add a slim connected-providers route (only the fields the composer, model picker and usage meters use).
  - Run `bun run generate` in packages/client and the legacy SDK build if routes change.
- **App:**
  - Make bootstrap use the slim route.
  - Load the full catalog lazily, in the connect-provider/manage-models dialogs.
  - Keep one query per server on the v1 path.
  - Remove the 5-minute refetch.
  - Invalidate on provider/config/auth events.
- **Tests:**
  - ETag/304;
  - slim shape;
  - single query;
  - dialogs still list all providers;
  - harness `startup` and `switch` before/after.
- **Commit:** `perf: serve a slim, cached provider list`

### Task 2: Timeline projection per turn (F2)

- **Changes:**
  - Per-turn row memos (`mapArray` over turns).
  - A per-part non-empty memo instead of reading `part.text` in `renderable`.
  - A per-tag shallow row equality instead of `Equal.equals`.
  - `touch()` once per session per flush, and never for unopened sessions.
- **Tests:**
  - Row key stability in `row-reconciliation`.
  - A projection recomputes only the active turn (count recomputes).
  - Harness `stream2 4` before/after.
- **Commit:** `perf(app): rebuild only the active turn while streaming`

### Task 3: Streaming markdown and scroll work (F3)

- **Changes:**
  - Copy-button labels created once (default equality).
  - The worker protocol sends appended text only and returns `{ firstChangedBlock, blocks }`.
  - Scroll-state and thumb reads coalesced into one rAF read phase.
  - The virtualizer is the single bottom-lock owner; remove the duplicate `createAutoScroll` timeline lock and the microtask `scrollToEnd`.
- **Tests:**
  - Copy buttons still work, including their state after a copy.
  - The worker diff protocol.
  - Bottom-lock behaviour stays stable: run the `e2e/performance/timeline-stability` suite.
  - Harness `stream` and `stream-short` trace before/after.
- **Commit:** `perf(app): cut per-delta markdown and layout work`

### Task 4: History paging (F4)

- **Changes:**
  - Apply history pages in chunks across frames (or page 50 at a time).
  - Prefetch via a sentinel about 2 screens from the top.
  - No layout reads in `resizeItem`.
  - No re-measure on index shift.
  - Tool triggers in timeline rows use `content-visibility: visible`.
  - A byte-capped markdown cache of finished parts.
- **Tests:**
  - Prepend anchoring stays put.
  - Harness `scroll` before/after.
  - The timeline-stability suite.
- **Commit:** `perf(app): page older history without freezes`

### Task 5: Desktop startup (F6)

- **Changes:**
  - Create the window right after protocol/IPC registration; the splash waits for initialization and shows the one-time DB compaction message.
  - Renderer `build.minify: "esbuild"` with sourcemaps.
  - `codeCache: true` on the `oc://` scheme.
  - `module.enableCompileCache()` in the sidecar.
  - `lazy()` the inactive layout and secondary pages.
- **Measure:** the packaged app's time-to-window. Use a fake-HOME sandbox and the unpacked binary with `--remote-debugging-port`; never the owner's install.
- **Verify:** desktop typecheck; `OPENCODE_CHANNEL=dev bun run build` succeeds.
- **Commit:** `perf(desktop): show the window before the server is ready`

### Task 6: Background churn, typing and minor items (F5, F7, F8)

- **Changes:**
  - Warm neighbours only when the routed session changes (±1 neighbour, 20 messages).
  - Refresh `meta.at` on live events.
  - A forced refresh fetches the first page only.
  - Debounce draft persistence (~300 ms; flush on blur, submit and unload).
  - Debounce and abort the mention search.
  - Move notifications to their own trimmed store and debounce desktop store writes.
  - Narrow the timeline MutationObserver.
- **Tests:**
  - Draft flush on submit and unload.
  - Mention abort.
  - Prefetch triggers.
  - Harness `typing` and `startup` before/after.
- **Commit:** `perf(app): reduce background churn and per-key work`

### Task 7: Verification and spec sync

- [ ] Run all harness benchmarks and record the final numbers against the goals.
- [ ] Run `packages/app` browser suite + `bun run test:bench` + typecheck (app, ui, session-ui, desktop, flynncode).
- [ ] Sync the spec with the implementation and the measured results.
- [ ] Commit `docs: record UI responsiveness results and sync the spec`.
