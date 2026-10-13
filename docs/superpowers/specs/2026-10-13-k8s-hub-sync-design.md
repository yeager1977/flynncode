# K8s Hub Sync Design

Date: 2026-10-13
Status: draft for review
Prior art: `2026-10-08-machine-sync-design.md`, plan `docs/superpowers/plans/2026-10-08-machine-sync.md`

## Goal

Replace LAN P2P sync with a central full Flynncode server on a k8s pod as source of truth. All laptops sync to/from the hub when reachable, keep working fully offline when not.

Decisions (from brainstorming):
- Topology: star (hub-spoke), central source of truth.
- Hub role: full server (SQLite + `/flynncode-sync/*`), not dumb storage, not remote-runner-only.
- Offline: offline-first, opportunistic access. Unreachable hub never blocks local work.
- Secrets: blind-relay default. Hub stores masked bundles only and cannot execute provider turns.

## Architecture

Spokes are existing desktops. Each spoke keeps exactly one peer, which becomes the hub URL (`https://<hub>:4097` + per-machine Bearer token). No store migration is needed because the current one-peer model already fits star topology from the spoke side. The hub has zero peers.

Hub deployment:
- Image: same `packages/flynncode` server container already used by desktop sidecar.
- Workload: `StatefulSet` with 1 replica, `ReadWriteOnce PVC 10Gi` for SQLite. Never `emptyDir`.
- Network: Tailscale sidecar on tailnet to start. No public ingress in v1.
- Env: `SYNC_HUB_MODE=1` meaning never start a sync worker, never report paused, only serve.
- Auth: per-machine 256-bit Bearer tokens stored as k8s Secret `hub-sync-tokens`, compared with `timingSafeEqual`. Pairing uses existing 6-digit single-use code flow or kubectl-created token for headless setup.
- Health: liveness `GET /flynncode-sync/manifest` with valid Bearer, readiness same plus SQLite writable check.

Key gap vs LAN P2P: `decide()` in `packages/mobile-gateway/src/sync-decide.ts` is pull-only with the invariant "each machine only ever writes its own DB." Two laptops converge because both pull each other. A hub that never pulls starves. Hub must therefore expose authenticated writes and spokes must add a push phase. The current gateway comment that `apply/delete/archive` stay loopback-only gets a single hub-mode exception.

## Components

1. `packages/flynncode/src/server/routes/instance/httpapi/machine-sync.ts`
   - Hub-mode guard: when `SYNC_HUB_MODE=1`, accept remote `POST /flynncode-sync/apply`, `POST /flynncode-sync/delete/:id`, `POST /flynncode-sync/archive/:id`, `POST /flynncode-sync/settings/apply` with valid spoke Bearer. Reads (`manifest`, `session/:id`, `settings`) unchanged. Non-hub mode keeps current loopback-only write behavior.
   - All hub writes run inside existing `MachineSyncStore` SQLite transaction. Stale `expected` version returns 409 with `stale`, busy chat returns 409 with `busy`, same contracts as loopback today.

2. `packages/mobile-gateway/src/sync-decide.ts`
   - Add `decidePush(local, hubManifest)` as the inverse of `decide()`: emits `push/delete/archive/skip` for chats where local is newer than hub, same newest-`time_updated` wins, equal keeps hub (do nothing), same busy guard on both sides, same tombstone and archive rules (archived chats never pushed when missing on hub, tombstone only pushes when `timeDeleted > hub.timeUpdated`).

3. `packages/mobile-gateway/src/sync-worker.ts`
   - After existing pull batch, run push batch sequentially (max 20 per cycle, same `BATCH_SIZE`, 1s `BATCH_DELAY_MS` while backlog remains). For each push action: read local bundle via loopback `GET /flynncode-sync/session/:id`, then `POST` to hub with `expected` hub version. Reuse existing `POLL_MS 60s`, `BACKOFF_AFTER_FAILURES 5`, `BACKOFF_MS 5min`, `sent` counter, and status phases.
   - No parallel floods. Abort push batch on `unauthorized/paused/clock/unreachable` same as pull.

4. Desktop + sidecar (`packages/desktop/src/main/`)
   - `syncPeer` becomes hub URL + token. Hub has no peer. Pairing, pause, phone-access, and status cache code unchanged. Existing phases `offline/unauthorized/mismatch/peer-paused/clock-skew` already express "access when accessible."

5. App UI (`packages/app`)
   - No new card in v1. Sync card shows hub name + `lastSuccess` + backlog. Reuse copy for unreachable and pair-again states.

## Data flow

Pull (existing, spoke <- hub):
- `GET hub/manifest`, `decide()`, parent-first ordering, `GET hub/session/:id` (409 means hub-busy, skip), loopback `POST /flynncode-sync/apply` with local `expected`. Batch 20, sequential.

Push (new, spoke -> hub):
- `decidePush()` over local manifest vs hub manifest, same parent-first ordering against local parent map.
- For each push: loopback read local bundle, `POST hub/apply { bundle, expected: hubVersion }`. Deletes carry `{ timeDeleted, expected }`, archives carry `{ timeArchived, expected }`.
- Hub applies transactionally or returns 409. Spoke retries next cycle. No partial apply survives (rollback on per-chat failure, listed in `failures`, retried).

Config/settings/prefs:
- Global config newest mtime wins, tie keeps receiver. Applying sets local mtime to sender mtime so next cycle ties. `server` block never sent, never overwritten. Secrets masked as `__flynncode_sync_secret__`, placeholders never land in files, local secret leaves survive. Identical in both directions.
- App prefs use `syncUpdatedAt` newest wins, same synced-section allowlist as LAN sync.

## Error handling and offline

- Hub unreachable or gateway 502/503/504: `offline`, local work continues, backoff to 5min after 5 failures, reset on success.
- Hub 401 with valid signature: `unauthorized`, surface "Pair again." Unsigned 401 treated as unreachable, not unauthorized.
- Schema/app mismatch: `mismatch`, pause with "Update Flynncode on both machines."
- Clock skew on signed requests: `clock-skew` until clocks agree.
- Split-brain (two spokes edit same chat offline): newest `time_updated` wins, loser overwritten. Documented limitation carried over from LAN sync. No merge, no CRDT in v1.
- Hub storage: pod restart must reattach same PVC. Loss of PVC means loss of hub truth; spokes retain full copies and re-seed hub on reconnect via push phase. Nightly PVC snapshot plus `sqlite3 .backup` to object storage. Restore runbook: restore snapshot, restart StatefulSet, spokes backfill.

## k8s ops (v1 minimal)

- `StatefulSet/sync-hub`: 1 replica, requests 0.5 CPU/1Gi, limits 2 CPU/4Gi, PVC `sync-hub-data 10Gi RWO`, Tailscale sidecar container, env `SYNC_HUB_MODE=1`, ports 4097.
- Secrets: `hub-sync-tokens` holding per-machine tokens, mounted as env or volume, never logged.
- Probes: liveness and readiness against authenticated manifest endpoint.
- Backups: nightly volume snapshot, plus hourly SQLite backup sidecar push to object storage. Retention 7 days.
- Logs: reuse `[machine-sync]` prefix, expose `consecutiveFailures`, `received/sent`, `lastSuccess` for alerting.

## Testing

- Unit (`bun test` from package dirs): `decidePush` inverse cases (local-newer pushes, hub-newer does nothing, equal does nothing, busy both sides skips, tombstone threshold, archived-missing never pushes), hub auth accept/reject including timing-safe compare, blind-relay masking (hub bundle has no real secrets, no `server` block).
- HTTP API: hub-mode writes allowed with Bearer and rejected without, non-hub mode still rejects remote writes, 409 stale/busy contracts preserved.
- E2E: spoke A creates chat offline, reconnects, pushes to hub, spoke B pulls; delete propagates via tombstone; busy chat skipped on both sides; config newest-mtime wins spoke-hub-spoke.
- Chaos: kill hub pod mid-push, verify spoke retry and no partial chat on hub; wipe hub PVC, verify spokes re-seed hub; clock-skew and 401 surfaces correct status.
- Typecheck `bun typecheck` in each touched package. No public HttpApi change, so no `bun run generate` and no SDK rebuild.

## Non-goals

- No multi-hub, no hub-to-hub replication.
- No live streaming or realtime push; 60s poll stands.
- No per-field merge or CRDT; whole-chat newest wins.
- No public ingress, no hub-side execution with real keys in v1.
- No changes to open tabs, drafts, window state, file snapshots.
