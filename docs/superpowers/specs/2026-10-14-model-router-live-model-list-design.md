# Model Router: Live Model-List Freshness - Design

Date: 2026-10-14
Status: Approved (pending spec review)

## Problem

The router derives its candidate pool (every routing decision, `rank_models`,
`route_task`, `auth_status`) from a cached connected-provider catalog. That
snapshot goes stale in ways the app model picker does not:

1. **Vendor connect/disconnect mid-session.** Signing in or out of a provider
   publishes `integration.connection.updated`, and the app refreshes its picker
   instantly, but the plugin caches its catalog until an instance rebuild.
   New vendors never route; signed-out vendors keep being routed into until a
   prompt fails.
2. **The hourly refresh is dead.** The plugin's event listener drops
   location-less (global) events — `models-dev.refreshed` has no location — so
   the intended models.dev-refetch on the hourly poll never fires.
3. **New or removed models** (discovery-based providers such as local Ollama
   pulls) have no event at all; they only surface at a models.dev refresh or
   restart, if ever.
4. **Manage Models visibility** is a client-side store. The server plugin only
   learns about hidden models when a router-settings Save snapshots them into
   `excludeModels`; hiding a model otherwise has no effect on the router.

App settings saves already rebuild instances instantly (global config update →
dispose all instances), so router options and provider enable/disable land
immediately through that path. Machine-sync changes deliberately keep the
"Reload to apply" flow.

## Goal

Routing and router tools always use a model list that mirrors what the app
considers available (connected providers, current catalog, discovered models)
and enabled (not disabled by `disabled_providers`/`enabled_providers`, not
hidden in Manage Models).

## Design

### 1. Server: fresh Provider state (`packages/flynncode/src/provider/provider.ts`)

- New subscription: like the existing `ModelsDev.Event.Refreshed`
  subscription, subscribe to `Integration.Event.ConnectionUpdated` from the
  layer fiber and `InstanceState.invalidateCurrent(state)`. Makes
  `provider.list()` correct for sign-out (previously the per-directory state
  kept a signed-out provider listed as connected) and instant for sign-in.
- TTL: `InstanceState.make` gains an optional `timeToLive` option passed
  through to `ScopedCache.make` (which already supports per-entry TTL). The
  Provider Service builds its per-directory state with a **5-minute TTL**,
  matching the app's provider-poll interval. The next read after expiry
  rebuilds state, which re-runs openai-compatible model discovery — that is
  how new/removed models (Ollama pulls) appear without a restart. Discovery
  failure keeps configured models (existing behavior).
- The hourly models.dev subscription stays as an immediate invalidation.

### 2. Plugin: dirty-flag + TTL catalog (`packages/flynncode/src/plugin/ollama-model-router/index.ts`)

- The catalog cache gains a `loadedAt` timestamp. `loadCatalog()` refetches
  when nothing is cached, the cache is older than **5 minutes**, or an
  invalidation event fired since the last load. Concurrent callers share one
  in-flight fetch.
- On refetch failure with an existing catalog: keep it (stale beats nothing)
  and stay due for retry. On first-load failure: fall back to raw config
  providers (unchanged).
- New invalidation triggers: `integration.connection.updated` (in addition to
  the existing `models-dev.refreshed` type check).

### 3. Plugin infra: deliver global events to plugins (`packages/flynncode/src/plugin/index.ts`)

- Fix the listener location filter so location-less (global) events reach
  instance plugins:
  `if (event.location?.directory !== undefined && event.location.directory !== ctx.directory) drop`.
  Events scoped to another directory stay filtered. This makes the router's
  dirty flags — and the previously dead hourly models.dev refresh — actually
  receive their signals.

### 4. App: Manage Models visibility writes through (`packages/app`)

- The Manage Models visibility toggle updates the client store as today
  (picker stays instant) and writes the full hidden-list to global config as
  `model_router.excludeModels` — the same write path the router editor and
  provider-connect flow already use (`global.config.update`; partial patch
  preserves other `model_router` keys and replaces the `excludeModels` list).
- Writes are coalesced with a **300 ms trailing debounce** so toggling several
  models causes one instance rebuild, not one per toggle. A failed write shows
  a toast (new i18n key; English source copy in `en.ts`).
- `model_router.excludeModels` becomes the server-side mirror of Manage Models
  visibility — matching what the README already says it is. The written list
  is every key (`providerID/modelID`) currently hidden in the client store.
  A write replaces the whole list, so hand-edited entries (never a documented
  workflow) get overwritten the next time visibility changes; identical to the
  old editor-Save snapshot semantics.
- Multi-server: the write targets the current server connection.
- The router-editor Save stops computing its client-side snapshot: the
  `excludeModels` field is no longer included in its payload (it displays
  hidden models derived from server config). This closes the race where an
  editor Save overwrote fresh Manage Models changes with a stale baseline.

## Data flow

- **Connect/disconnect:** event → server state invalidated → plugin marks
  catalog dirty → next routing decision, tool call, or sentinel resolution
  refetches `provider.list()` once. A prompt that already resolved its model
  is unaffected.
- **Pulls / discovery changes:** provider state TTL expires (≤5 min) → next
  read rebuilds → the plugin's own TTL refetch or dirty refetch picks it up.
  The app picker gains the same freshness for free.
- **Manage Models toggle:** local store instantly → debounced config write →
  instance disposal → router re-loads with fresh config.
- **Settings Save / machine sync:** unchanged.

## Error handling

- Catalog refetch failure keeps the existing catalog, stays dirty, retries on
  the next trigger; first-load failure falls back to raw config providers.
- Server TTL rebuild failure surfaces to the calling effect like a cold build
  error today.
- Manage Models config-write failure toasts (new i18n key); client-side
  visibility already applied.
- Global events reaching plugin hooks is additive; hooks that do not
  type-check them ignore the traffic, and hook execution stays isolated.

## Testing

- Plugin (`packages/flynncode/test/plugin/ollama-model-router/`): loadCatalog
  TTL/stale/refetch-on-event (scripted fake client returning two different
  provider lists, assert the second fetch lands; failed refetch keeps the
  stale catalog); event hook dirties for both event types; routing after
  invalidation picks up a newly connected vendor.
- Plugin infra: global events reach the hook; other-directory events stay
  filtered.
- Server provider TTL: invalidation on `Integration.Event.ConnectionUpdated`,
  and TTL-expiry rebuild via `it.effect` with `TestClock` advancing past
  5 minutes.
- App: payload/contract tests updated for the editor no longer emitting
  `excludeModels` (including `packages/app/test-browser/model-router-contract.test.ts`
  if it asserts the Save snapshot); Manage Models write-through unit test
  (toggle → debounced patch `{ model_router: { excludeModels: [...] } }`);
  `packages/app/e2e/regression/model-router.spec.ts` updated where it depends
  on the snapshot behavior.
- `bun typecheck` in `packages/flynncode` and `packages/app`; tests run from
  package directories, never the repo root.

## Out of scope

- Server-authoritative visibility for the model picker (picker keeps its
  local store; only the router reads the config mirror).
- Making machine-sync changes apply to running instances — "Reload to apply"
  remains the product rule.
- `legacyAssign` live refresh (agent models still assigned at boot only).
- Config knobs for the TTLs (fixed 5-minute internal constants, documented in
  the README).
- Live re-read of project-level `opencode.jsonc` edits under a running server
  (config changes still ride dispose/reload).

## Related specs

- `2026-09-14-ollama-model-router-design.md` — catalog caching and sentinel.
- `2026-09-17-model-router-all-models-design.md` — `excludeModels` snapshot
  this spec replaces; listed "Live re-routing without restart" as out of
  scope, which this now delivers.