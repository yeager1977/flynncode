# UI Responsiveness Design

Date: 2026-10-28
Status: implemented on `dev` (`7c01def196`..`c4031fcd1c`); results measured 2026-10-28, see Results. The owner asked for all of typing, scrolling, switching, streaming and startup.

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

The fixes are grouped by area, in order of impact. Each group shipped as its own commit.

### 1. Provider catalog (F1)

- **Server:** the provider list is serialized once per revision and the bytes are cached. A revision is keyed by the provider state record (rebuilt per directory when config, the models.dev catalog or integrations change), the config, the catalog and the set of stored credential keys. Responses carry a content-hash ETag with `Cache-Control: no-cache`, so an unchanged list answers 304. The cache is built on the first request after a revision change, not in the background: a cold full list still costs about 1.5 s once, but nothing on the boot path asks for it.
- **Slim endpoint:** `GET /provider/connected` returns the same `ListResult` shape with only the connected providers. Provider `options`, model `options`/`headers` and variant settings are emptied (variant keys kept); names, costs, limits and capabilities are unchanged. It is ETag-cached too.
- **Announcing changes:** a provider connected or removed anywhere is published as `integration.connection.updated` (an existing event), which also rebuilds provider state on the server:
  - the auth routes (`PUT`/`DELETE /auth/:providerID`) and the OAuth callback, when the entry is new or removed. Token refreshes rewrite an existing entry and stay quiet;
  - `auth.json` written by another process (the CLI's `auth login`, a TUI, another server). It is watched by a 2 s stat poll, because writers replace it by rename, and only a changed credential key set is announced, once per process.
- **Client:**
  - On v1 the composer, model picker and usage meters read the slim list through one query per server; directory queries share its request. A directory whose own config sets `provider`, `enabled_providers` or `disabled_providers` differently from the global config (compared once both have loaded) reads its own slim list through its directory client instead. Servers without the slim route fall back to `/provider`.
  - There is no `refetchInterval`. The provider queries are invalidated on `config.updated`, `catalog.updated`, `models-dev.refreshed`, `integration.connection.updated`, `global.disposed`, `server.instance.disposed`, and on a reconnect (not the boot connect). Invalidation refetches only the lists in use.
  - The full catalog (`providerCatalog` query) loads on demand: the connect-provider and manage-models dialogs, the custom-provider form, the unpaid-model dialogs, the settings provider panels and the model-router settings. Those pickers show a loading row and an error row with a retry while it is missing, and a preselected provider still opens (named by its ID) if the catalog fails.
  - Messages from providers that are no longer connected resolve their model name and context limit from the full catalog: the first lookup that misses the slim list turns the catalog query on in idle time (once, ETag-revalidated), so it never delays the session that asked. Timeline labels and the usage meters use it.

### 2. Timeline projection per turn (F2)

- **Per-turn rows:** a `turns` memo groups messages into turns, and `mapArray` over turn IDs gives each turn its own memos and row construction. Settled turns get status `"idle"`, so a delta rebuilds only the active turn, and the concatenated row array keeps its identity when every row is unchanged.
- **Cheap visibility check:** `renderable(part)` reads a per-part memo of "has non-whitespace text" (`hasPartText`), so a delta on a non-empty part does not invalidate its turn.
- **Row comparison:** `sameRow` compares per tag and field; Effect `Equal.equals` is gone from row reuse.
- **Cache touch:** events touch the session cache once per session per flush, in a microtask. Sessions the user has not opened (such as sub-agents) go to their own bounded LRU, so they never evict viewed ones.

### 3. Streaming markdown and scroll work (F3)

- **Copy-button labels:** one labels memo per Markdown, read by each button; the label signal uses default equality, and the icon is no longer rebuilt per update.
- **Markdown worker:** the client sends appended text only and the worker returns `{ firstChangedBlock, blocks }` from the first changed block on. A mirror of what the worker holds advances only on matching successful replies; an error resends the whole text.
- **Scroll-state reads:** coalesced into one `requestAnimationFrame` read phase; store-update effects no longer read layout.
- **Bottom-lock:** a single owner, the virtualizer (`anchorTo: "end"`). The duplicate `createAutoScroll` ResizeObserver lock and the microtask `scrollToEnd` are removed; `scrollToEnd` is gated on the virtual end (`atVirtualEnd`), which reads no layout.

### 4. History paging (F4)

- **Paging:** older history pages 50 messages at a time (was 200). An IntersectionObserver sentinel about two screens above the top starts the next page; a page that still leaves the reader near the top loads the next one.
- **No layout reads in sizing:** `resizeItem` no longer reads layout. Measurements in one batch update the virtualizer at once, but its adjustment scroll write and its view notification are deferred to one microtask flush (still before paint). Rows are not re-measured on an index shift, because sizes are keyed by row key. Prepends anchor on the first visible row through the virtualizer's own count-change anchor.
- **Tool headers:** `content-visibility: auto` stays on tool triggers. Switching them to `visible` was measured and doubled the 4x scroll long tasks.
- **Markdown cache:** a 16 MB byte-capped LRU of sanitized HTML for finished blocks replaces the 200-block cap.

### 5. Desktop startup (F6)

- **Window first:** the window, tray and menu open right after protocol and IPC registration, while the sidecar loads. Sidecar failures still reach the already-open renderer. The splash says "Optimizing history database…" while the one-time compaction runs.
- **Minify:** the renderer is minified with sourcemaps kept (entry chunk 6.3 MB to 3.1 MB).
- **Code caching:** `codeCache: true` on the `oc://` scheme, and `module.enableCompileCache()` in the sidecar, flushed after it is ready.
- **Lazy loading:** the legacy layout, legacy home, usage and cleanup pages are lazy; the default new layout stays eager.

### 6. Background churn, typing and minor items (F5, F7, F8)

- **Prefetch:** neighbours are warmed only when the routed session changes: ±1 neighbour, 20 messages, and a re-sorting session list no longer re-triggers it.
- **Staleness and missed events:**
  - Live events refresh `meta.at` (at most once a second), so a session streaming in the background is not stale.
  - A forced refresh fetches the newest page (20 messages), then older pages (up to 10 of 50) until it reaches the newest message already held. It then keeps the loaded history and its cursor; if it cannot reach that message, paging continues from the last page read.
  - A reconnect after the boot connect, or `global.disposed`, marks every loaded session stale and remembers the newest message held. Live events do not restore freshness until a reload, a revisit refreshes and fills the gap, and the routed session reloads at once.
- **Typing:**
  - Draft persistence is deferred by 300 ms and flushed on submit, blur, `pagehide`, `beforeunload`, hidden and owner cleanup.
  - The mention search is debounced by 150 ms and superseded searches are aborted. Enter while a search is pending runs it now and selects from its results.
- **Notifications store:** notifications live in their own trimmed store (`opencode.notification.dat`, 500 entries, 30 days, error entries slimmed to name and a 200-character message), migrated once from the global store.
- **Desktop store writes:** IPC writes are buffered per store and written once per 300 ms burst, flushed on quit and session end. A delete or clear first writes everything still buffered, so a migration cannot lose both copies on an abrupt exit.
- **Mutation observer:** the timeline's reconnect observer watches only the scroll element's ancestors' child lists, and the whole root only while the element is detached.
- **Turn start and end:** the command catalog persists only changed entries, the todo dock mounts its rows in idle time, and an archived session that keeps receiving updates no longer has its loaded content evicted (that eviction rebuilt the whole timeline every turn).

## Error handling and risk

- Every change keeps behaviour identical except for timing, apart from three deliberate additions: provider changes made elsewhere now reach every client, a refresh after missed events fills the gap it used to leave, and Enter after typing a mention picks from the typed query. The riskiest areas are row identity and keys (virtualizer measurement caches) and scroll anchoring. Each is covered by existing tests (`row-reconciliation`, `e2e/performance/timeline-stability`), plus new ones.
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
- **Missed events and providers:** gap fill after a forced refresh, reconnect staleness, auth-change announcements (routes and `auth.json`), lazy model lookup for disconnected providers, per-directory provider config, the stale-Enter mention search and the store-write flush before a delete.
- **Re-measurement:** after each group, re-run the relevant harness benchmarks (`bun bench.ts startup|switch|typing|scroll|stream|stream2 4`) and record before/after numbers in the task reports.
- **End to end:** the `packages/app/e2e/performance` suite (`bun run test:bench`) and the timeline-stability tests pass.

## Results

Measured 2026-10-28 with the harness (`.git/sdd/perf-harness/bench.ts`) on a sandbox copy of the owner's `opencode-dev.db` (Python `sqlite3` backup into `~/.cache/flynncode-perf`, fake HOME, mock LLM), the server from source and a production web build in headless system Chrome. "Before" is the investigation baseline (`perf-investigation.md`, same harness and data, before any of this work). "After" is `dev` at `5faa598de8` and `62e1157b5f` (which only moves the catalog load for old messages to idle time; startup and switch were measured on it), two to three runs of each benchmark; ranges are min–max.

| Goal | Before | After | Met? |
|---|---|---|---|
| Composer ready ≥1 s sooner (`startup`, root) | 1,911–2,499 ms (avg 2,185) | 546–1,435 ms (avg 807; the 1,435 ms run is the first after a server start) | Yes, −1.4 s |
| Direct open of the longest session ≥1 s sooner (`startup`, first content) | 1,578–1,771 ms (avg 1,675) | 770–861 ms (avg 820) | No, −0.86 s |
| No `/provider` call blocking other requests, no 5-minute stalls | 4 × 7.2 MB `/provider` at boot, 0.8–2.7 s each, blocking other requests 0.9–1.7 s; refetched every 5 min | 2 × 6.8 KB `/provider/connected`, 106–164 ms in warm runs (595 ms in the first run after a server start; 304-able); no polling; the full catalog loads only in dialogs or in idle time for old messages | Yes (a cold full catalog still takes ~0.9 s once per provider revision when something asks for it) |
| No long task over 100 ms while streaming at 4× (`stream2 4`) | short 116 ms; long +history 410 ms | short 93–124 ms; long +history 103–136 ms | No |
| Main-thread busy while streaming down ≥30% | `stream` short, 1×: 4,457 ms; 4×: 11,585 ms | 1×: 2,608–2,978 ms (−33% to −41%); 4×: 9,453–9,930 ms (−14% to −18%) | Yes at 1× (also trace RunTask −30%, task 3); no at 4× |
| No frame over 100 ms when paging history (`scroll`) | 1×: worst 267 ms, 6 long tasks (max 276); 4× (task 4 before): worst 383–400 ms | 1×: worst 50–83 ms, 0–1 long tasks (max 56); 4×: worst 367 ms, max long task 261–272 ms | Yes at 1×; no at 4× |
| Typing p95 ≤25 ms while streaming at 4× (`stream2 4`) | short 42.9 ms; long 21.4 ms* | short 31.4–41.4 ms; long 36.6–41.4 ms | No |
| No session-switch long task over 60 ms (`switch`) | 55–112 ms per switch (one switch 265 ms total) | 53–159 ms per switch | No |
| Desktop window before the sidecar has loaded | ~3.49 s to window (waited for the sidecar) | ~1.61 s; the renderer awaits initialization while the sidecar loads (task 5, packaged app, not re-run here) | Yes |

\* The baseline long-session stream was not bottom-anchored and the session (archived in the owner's DB) was torn down at each turn, so it rendered almost nothing; the after runs render the streamed markdown with history loaded.

Other numbers:
- Idle typing key-to-frame p95 stays at frame cadence: 17.6–17.8 ms before, 17.0–18.4 ms after.
- Startup API calls: 39 before, 30 after. Boot `/message` prefetches: 5 × 200 messages before, none after.
- First click-to-content into the longest session: 242 ms before, 253–264 ms after; revisits 70–83 ms before, 85–267 ms after. The before runs cached 200-message prefetches; after, neighbours prefetch 20 and a stale revisit refreshes the first page.
- History pages: 3 × 200 messages before, 50 at a time after.

What remains: at 4× CPU, streaming render (markdown blocks and tool rows mounting), the row mounting of a 50-message page and the first render of a long session still produce 100–270 ms tasks. Lazy or cheaper tool-row mounting and ramping overscan after a prepend are the next steps. Raw JSON, the sandbox config and the run scripts are in `.git/sdd/perf-harness/ur-final/`; the baseline is `.git/sdd/perf-harness/results-*.json`.

## Out of scope

- A combined `/bootstrap` endpoint, a later step.
- HTTP/2 for the sidecar connection.
- Server-side delta coalescing beyond what group 3 needs.
