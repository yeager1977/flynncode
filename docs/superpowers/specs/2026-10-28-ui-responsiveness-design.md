# UI Responsiveness Design

Date: 2026-10-28
Status: approved direction (the owner asked for all of typing, scrolling, switching, streaming and startup), pending implementation plan

## Problem

The owner finds the desktop app less responsive than Claude's. A measured investigation on 2026-10-28 (`.git/sdd/perf-investigation.md`) used a production web build against a read-only copy of the owner's 13.5 GB history and headless Chrome. It found:

- **Startup / open:** `/provider` returns 7.2 MB (234 providers, 8,943 models; only 2 are connected) and blocks the server for 0.5–0.84 s per call. It is fetched 4× at boot, 2× per newly visited project, and every 5 minutes. The composer is ready at 1.9–2.5 s.
- **Streaming:** every 16 ms SSE batch rebuilds the timeline rows for the whole loaded history, with structural `Equal.equals` per row and a cache `touch()` per event. The worst freeze was 410 ms in a long session at 4× CPU.
- **Streaming in any session:** copy-button labels are re-applied to every code block on every update (about 10% of CPU). The worker returns all blocks per delta, and 5,556 forced layouts per stream come from scroll-state reads. The main thread is 46% busy at 1×.
- **Scrolling into older history:** 200-message pages are applied in one go and rows are measured synchronously. That gave 6 long tasks (622 ms, worst 276 ms) over 3 pages. Warm scrolling holds 60 fps.
- **Desktop startup:** the window waits for the sidecar import (about 1.3 s). The renderer bundle (6.2 MB) is unminified, there is no V8 code cache, and all layouts and pages are imported eagerly.
- **Background churn and typing:** neighbour prefetch fires on every sidebar re-sort, forced refreshes reload everything loaded so far, a whole-store `JSON.stringify` runs per keystroke for drafts, and mention search fires on every key.

## Goals

Measured with the investigation's harness (`.git/sdd/perf-harness/`) on the same data, before and after:

- **Composer and session open:** composer ready and direct session open ≥1 s sooner. No `/provider` call blocks other requests. No 5-minute stalls.
- **Streaming:** no long task over 100 ms while streaming in the longest session at 4× CPU. Main-thread busy time while streaming down by at least 30%.
- **History paging:** no frame over 100 ms when scrolling up through history pages.
- **Typing:** key-to-frame p95 at or below 25 ms while streaming at 4× CPU.
- **Switching:** no session-switch long task over 60 ms.
- **Desktop window:** visible before the sidecar finishes loading.
- **No regressions:** in scroll anchoring, virtualization, copy buttons, model picker or usage meters. The existing `packages/app/e2e/performance` suite stays green.

## Design

The fixes are grouped by area, in order of impact. Each group is independently shippable.

### 1. Provider catalog (F1)

- **Server:** build the provider list once per config, auth or catalog revision and cache the serialized bytes. Serve them with an ETag, so an unchanged list returns 304. Rebuilding happens off the request path.
- **Slim endpoint:** a new route returns only connected providers and their models, with just the fields the composer, model picker and usage meters read. The full catalog is fetched lazily, only when the connect-provider or manage-models dialogs open.
- **Client:**
  - One provider query per server, not per directory, on the v1 path.
  - Remove the 5-minute `refetchInterval`.
  - Invalidate on `provider`, `config` and `auth` events instead.

### 2. Timeline projection per turn (F2)

- **Per-turn rows:** build rows per turn (`mapArray` over turns, plus a per-turn memo), so a streamed delta only recomputes the active turn.
- **Cheap visibility check:** `renderable(part)` no longer reads `part.text` directly. A per-part memo of "has non-empty text" stops propagation once a part is non-empty.
- **Row comparison:** row reuse compares with a per-tag shallow check instead of `Equal.equals`.
- **Cache touch:** the session cache is touched once per session per flush, and never for sessions the user hasn't opened, such as sub-agents.

### 3. Streaming markdown and scroll work (F3)

- **Copy-button labels:** created once and updated only on locale change. The label signal uses default equality.
- **Markdown worker:** it receives appended text only and returns `{ firstChangedBlock, blocks }` from the first changed block on.
- **Scroll-state reads:** coalesced into one `requestAnimationFrame` read phase. No layout reads inside store-update effects.
- **Bottom-lock:** a single owner, the virtualizer. Remove the duplicate timeline `createAutoScroll` ResizeObserver lock and the microtask `scrollToEnd`.

### 4. History paging (F4)

- **Paging:** apply a history page in chunks across frames, or page 50 messages at a time. Start loading about 2 screens before the top via an IntersectionObserver sentinel.
- **No layout reads in sizing:** `resizeItem` stops reading layout. Rows are not re-measured on index shift, because sizes are keyed by row key.
- **Tool headers:** tool triggers inside timeline rows stop using `content-visibility: auto`.
- **Markdown cache:** a byte-capped cache of sanitized HTML for finished parts replaces the 200-block cap.

### 5. Desktop startup (F6)

- **Window first:** create the window right after protocol and IPC registration. The renderer's splash waits for initialization and says when the one-time database compaction is running.
- **Minify:** minify the renderer build with sourcemaps kept.
- **Code caching:** `codeCache: true` on the `oc://` scheme, and `module.enableCompileCache()` in the sidecar.
- **Lazy loading:** lazy-load the inactive layout and secondary pages.

### 6. Background churn, typing and minor items (F5, F7, F8)

- **Prefetch:** warm neighbours only when the routed session changes: ±1 neighbour, 20 messages.
- **Staleness:** refresh `meta.at` on live events, so a streaming session isn't stale. A forced refresh fetches only the first page.
- **Typing:**
  - Debounce draft persistence by about 300 ms, flushing on blur, submit and unload.
  - Debounce and abort the mention search.
- **Notifications store:** move notifications to their own trimmed store and debounce desktop store writes.
- **Mutation observer:** narrow the page-wide `subtree` MutationObserver in the timeline.

## Error handling and risk

- Every change keeps behaviour identical except for timing. The riskiest areas are row identity and keys (virtualizer measurement caches) and scroll anchoring. Each is covered by existing tests (`row-reconciliation`, `e2e/performance/timeline-stability`), plus new ones.
- The full provider catalog stays available on demand, so the provider dialogs keep working.

## Testing

- **Unit and browser tests** for each changed helper:
  - per-turn projection identity;
  - row equality;
  - the copy-button label effect;
  - the worker block-diff protocol;
  - the provider ETag and slim shape;
  - draft debounce;
  - mention-search abort;
  - prefetch triggers.
- **Re-measurement:** after each group, re-run the relevant harness benchmarks (`bun bench.ts startup|switch|typing|scroll|stream|stream2 4`) and record before/after numbers in the plan ledger.
- **End to end:** the `packages/app/e2e/performance` suite (`bun run test:bench`) and the timeline-stability tests pass.

## Out of scope

- A combined `/bootstrap` endpoint, a later step.
- HTTP/2 for the sidecar connection.
- Server-side delta coalescing beyond what group 3 needs.
