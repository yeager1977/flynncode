# Machine Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two Flynncode desktops on the same LAN (challenger ↔ starship) keep the same active chats, global config and app preferences, two-way, newest-wins per whole chat, each machine fully usable offline; plus an opt-in "Phone access" switch so the LAN gateway only exposes phone routes when the user turns them on.

**Architecture:** The database side lives in the server (`packages/opencode`): a `MachineSyncStore` Effect service builds the manifest, exports a whole-chat bundle and applies a bundle inside one SQLite transaction, and Flynncode-internal raw `HttpRouter` routes under `/flynncode-sync/*` (server Basic auth, outside the public HttpApi so no SDK/client regeneration) expose it. Deletions leave rows in a new core `session_tombstone` table written by the session projector. The LAN side lives in `packages/mobile-gateway`, which the desktop sidecar already runs in-process next to `Server.listen`: a `SyncGate` holds phone-access, pairing code, peer and token state; the gateway serves `/flynncode-sync/pair|unpair|prefs` itself and forwards only the read-only `manifest`, `settings` and `session/:id` routes to the local server for a Bearer-token peer, while every phone route returns 404 when phone access is off. **Decision — where the worker lives:** the sync worker is plain TypeScript in `packages/mobile-gateway/src/sync-worker.ts`, started by the sidecar (same process as the server). It never touches SQLite directly: it pulls the peer through the peer's gateway and writes its own database only through its own server's loopback-only apply routes, so every DB write stays inside the server's Effect runtime and transaction, and no Effect runtime has to be smuggled out of `Server.listen`. Pairing/peer/phone-access settings live in the desktop settings store, reach the sidecar in the `start` message and in live `sync-*` sidecar messages (never `process.env`), so turning phone access on/off and pairing take effect without an app restart (the sidecar starts/stops the gateway when `phoneAccess || peer || pairing code active` changes). **Decision — app preferences:** the renderer owns `settings.v3`; it stamps the synced sections with `syncUpdatedAt` on every local change and pushes `{ sections, updatedAt }` over IPC to desktop main, which persists it (`syncPrefs` store key) and forwards it to the sidecar's `SyncGate`; the peer pulls it from `/flynncode-sync/prefs`, and newer peer prefs travel back sidecar → main → every renderer window (`machine-sync-peer-prefs` IPC event), which applies them with the peer's stamp so nothing ping-pongs.

**Tech Stack:** Bun + TypeScript, Effect v4 (`effect/unstable/http` raw `HttpRouter` routes, `Context.Service`, `LayerNode`), Drizzle on SQLite (core migration generator `bun run migration`), `jsonc-parser` `modify`/`applyEdits`, `node:http` gateway, Electron main/preload/utility-process sidecar, SolidJS settings-v2 components, `bun:test`.

## Global Constraints

- Work on branch `machine-sync` created from `dev`; never commit to `dev` directly.
- Poll interval: 60 s (`POLL_MS = 60_000`) while paired and unpaused.
- Backoff: after 5 consecutive unreachable-peer cycles (`BACKOFF_AFTER_FAILURES = 5`) poll every 5 min (`BACKOFF_MS = 300_000`); the next successful cycle resets to 60 s.
- First sync: at most 20 bundles per cycle (`BATCH_SIZE = 20`); while a backlog remains the next cycle starts after 1 s (`BATCH_DELAY_MS = 1_000`); progress `{ done, total }` is reported.
- Tombstones: `session_tombstone(id, time_deleted)`; rows older than 30 days (`30 * 24 * 60 * 60 * 1000` ms) are pruned when the manifest is built.
- Pairing token: 256-bit random (`randomBytes(32).toString("hex")`, 64 hex chars), compared with `timingSafeEqual`, sent as `authorization: Bearer <token>`; the phone password never opens `/flynncode-sync/*` and the token opens nothing else.
- Pairing code: 6 digits, valid 10 minutes (`PAIRING_CODE_TTL_MS = 600_000`), single use, invalidated after 5 wrong attempts (`MAX_PAIR_ATTEMPTS = 5`).
- Gateway port 4097 (`MOBILE_GATEWAY_PORT`); A records B's URL as `http://<request remote IPv4>:4097`.
- Secret paths: any key matching `/(apiKey|api_key|token|secret|password)$/i` (suffix match, so `accessToken`/`refresh_token` are secret but `maxTokens` is not); any value below a `headers` map under top-level `provider` or `mcp`; any string containing `{env:…}` or `{file:…}`. They are sent as `"__flynncode_sync_secret__"`; the top-level `server` block is never sent and never overwritten; placeholders never land in a file; a secret present on the peer but absent locally stays absent; local secret leaves always survive.
- Global config: newest file mtime wins (tie keeps local); after applying, the local file mtime is set to the peer's mtime so the next cycle sees a tie.
- Busy means either engine is running the chat: the legacy runner's `session.status` busy/retry events OR membership in V2 `SessionExecution.Service`'s `active` set (packages/core/src/session/execution.ts). The manifest's `busy` flag and the local-busy skip both use this combined check.
- Chats: newest `time_updated` wins per whole chat; equal keeps local; local busy → skip; peer busy → skip; parents applied before children; archived chats are never pulled when missing locally.
- Schema/app version mismatch pauses sync with "Update Flynncode on both machines"; HTTP 401 from the peer shows "Pair again"; a per-chat apply failure is rolled back, listed, retried next cycle.
- Phone access is OFF by default (store key `phoneAccess` absent or `false`). When off, `/m`, the Basic-auth upstream proxy, `/flynncode-mobile-inbox`, `/flynncode-mobile-relay/*` and `/flynncode-mobile-status` all return 404 and only `/flynncode-sync/*` is served. The gateway process runs iff phone access is on OR a peer is paired OR a pairing code is active. Changes apply live (no restart).
- Synced app prefs: `settings.v3` sections `general`, `appearance`, `keybinds`, `notifications`, `sounds`, minus the `general` launch-state flags `newLayoutDesigns`, `layoutTransitionEligible`, `agentVisibilityInitialized`, `newInterfaceNoticeDismissed`, `shouldDisplayTabsToast`; stamp field `syncUpdatedAt`.
- Never synced: `app-version.v1` launch store, window state, open tabs, drafts, phone/relay/sync credentials, file snapshots.
- Peer address and token live only in the desktop settings store (`syncPeer`) and in sidecar start/IPC messages — never in `process.env` or config files. One peer per machine.
- Machine-sync server routes are raw `HttpRouter` routes, not `InstanceHttpApi`/Protocol endpoints, so `bun run generate` (packages/client) and `./packages/sdk/js/script/build.ts` are NOT required. If a task ever changes the public HttpApi/Protocol, run both.
- No `any`, no star or aliased imports in new code, bind Effect services to named variables (`const store = yield* MachineSyncStore.Service`), Drizzle snake_case columns, prefer `const`/early returns, avoid `try`/`catch`.
- Every new UI string goes into `packages/app/src/i18n/en.ts` AND the sorted `keys` list in `packages/app/src/i18n/flynncode-fallback.ts`; no hardcoded English in components.
- Tests only from package directories, never from the repo root. App tests: `cd packages/app && bun test --conditions=solid --preload ./happydom.ts <path>`. Typecheck with `bun typecheck` inside each touched package.
- Commits: conventional `type(scope): summary` with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File Structure

**packages/core**
- Modify `src/session/sql.ts` — add `SessionTombstoneTable` (`session_tombstone`).
- Generate `src/database/migration/<timestamp>_session_tombstone.ts`, and regenerated `src/database/migration.gen.ts`, `src/database/schema.gen.ts`, `schema.json` — migration for the new table (generator output, not hand-written).
- Modify `src/session/projector.ts` — the `SessionV1.Event.Deleted` projector also upserts a tombstone.
- Create `test/session-tombstone.test.ts` — tombstone written on delete.

**packages/opencode**
- Create `src/machine-sync/store.ts` — `MachineSyncStore` service: manifest (with busy flags and tombstone pruning), bundle export, transactional apply, delete, archive, missing directories, `isBundle` guard.
- Create `src/machine-sync/config-sync.ts` — `MachineSyncConfig`: secret masking for the outgoing global config and comment-preserving jsonc apply of a peer config.
- Modify `src/config/config.ts` — export `globalConfigFile()` and add `validateText(text, file)`.
- Create `src/server/routes/instance/httpapi/machine-sync.ts` — raw `/flynncode-sync/*` routes (manifest, session, apply, delete, archive, missing, settings, settings/apply).
- Modify `src/server/routes/instance/httpapi/server.ts` — mount the routes behind server auth and add `MachineSyncStore.node` to the app graph.
- Create `test/machine-sync/store.test.ts`, `test/machine-sync/config-sync.test.ts`, `test/server/httpapi-machine-sync.test.ts`.

**packages/mobile-gateway**
- Create `src/sync-decide.ts` — manifest types/guard and the pure per-chat decision + parent-first ordering.
- Create `src/sync-gate.ts` — mutable sync state shared by gateway and worker: phone access, pause, peer/token, pairing code, prefs, sent counter.
- Create `src/sync-routes.ts` — `/flynncode-sync/*` handling inside the gateway (pair, unpair, prefs, token-gated read-only forwarding).
- Create `src/sync-pair.ts` — pairing/unpairing client used by desktop main.
- Create `src/sync-worker.ts` — the 60 s pull loop with backoff, batches, status, settings and prefs pulls.
- Modify `src/gateway.ts` — `createGateway`/`startGateway` accept `sync?: SyncGate`; sync routing and phone-access 404 gating.
- Modify `package.json` — exports `./sync`, `./sync-gate`, `./sync-pair`, `./lan-ips`.
- Create `test/sync-decide.test.ts`, `test/sync-routes.test.ts`, `test/sync-worker.test.ts`, `test/sync-e2e.test.ts`.

**packages/desktop**
- Modify `src/main/store-keys.ts` — `PHONE_ACCESS_KEY`, `SYNC_PEER_KEY`, `SYNC_PAUSED_KEY`, `SYNC_PREFS_KEY`.
- Create `src/main/sidecar-sync.ts` — sidecar sync message types, parsers and `gatewayWanted`.
- Modify `src/main/sidecar.ts` — start the gate + worker, reconcile the gateway/relay live, handle `sync-*` commands.
- Modify `src/main/mobile-gateway-launch.ts` — pass the `SyncGate` to `startGateway`.
- Modify `src/main/server.ts` — `sync` in the start message, persistent sync message listener, `post()` to the sidecar.
- Create `src/main/machine-sync.ts` — main-process controller: store reads/writes, pairing, unpair, pause, phone access, prefs, status cache/broadcast.
- Modify `src/main/ipc.ts`, `src/main/index.ts` — IPC handlers and wiring.
- Modify `src/preload/index.ts`, `src/preload/types.ts` — `machineSync`, `getPhoneAccess`, `setPhoneAccess`.
- Modify `src/renderer/index.tsx` — expose `machineSync` on the platform.
- Create `src/main/sidecar-sync.test.ts`, `src/main/machine-sync.test.ts`; modify `src/main/mobile-gateway-launch.test.ts`.

**packages/app**
- Create `src/context/machine-sync-types.ts` — renderer-facing sync types (`MachineSyncPlatform`, status, prefs).
- Modify `package.json` — export `./machine-sync-types`.
- Modify `src/context/platform.tsx` — optional `machineSync` platform capability.
- Create `src/context/settings-sync.ts` — pure helpers: synced sections, stable key, peer merge.
- Modify `src/context/settings.tsx` — `syncUpdatedAt` stamp, push on change, apply peer prefs.
- Create `src/components/settings-v2/sync-card-status.ts` — pure status → copy helpers.
- Create `src/components/settings-v2/sync-card.tsx` — the Sync card.
- Modify `src/components/settings-v2/servers.tsx` — render the Sync card.
- Modify `src/components/settings-v2/phone-card.tsx` — "Phone access" switch.
- Modify `src/components/prompt-input-v2.tsx` — "Folder missing on this machine" notice.
- Modify `src/i18n/en.ts`, `src/i18n/flynncode-fallback.ts` — new keys.
- Create `src/context/settings-sync.test.ts`, `src/components/settings-v2/sync-card-status.test.ts`; modify `src/components/settings-v2/phone-card.test.tsx`, `src/components/prompt-input-v2.test.ts`.

---

### Task 1: Session tombstone table

**Files:**
- Modify: `packages/core/src/session/sql.ts` (append after `SessionContextEpochTable`, end of file)
- Generate: `packages/core/src/database/migration/<timestamp>_session_tombstone.ts`, `packages/core/src/database/migration.gen.ts`, `packages/core/src/database/schema.gen.ts`, `packages/core/schema.json`
- Modify: `packages/core/src/session/projector.ts` (the `events.project(SessionV1.Event.Deleted, …)` block, currently lines 258-260; import line 15)
- Test: `packages/core/test/session-tombstone.test.ts`

**Interfaces:**
- Consumes: `SessionTable`, `SessionSchema.ID`, `Database.Service`, `EventV2.Service`, `SessionProjector.node`.
- Produces: `SessionTombstoneTable = sqliteTable("session_tombstone", { id: text().$type<SessionSchema.ID>().primaryKey(), time_deleted: integer().notNull() })` exported from `@opencode-ai/core/session/sql`; every projected `session.deleted` event upserts `{ id: sessionID, time_deleted: Date.now() }`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/session-tombstone.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable, SessionTombstoneTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionV2.ID.make("ses_tombstone_test")

describe("session tombstones", () => {
  it.effect("records a tombstone when a session is deleted", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      const before = Date.now()

      yield* events.publish(SessionV1.Event.Deleted, {
        sessionID,
        info: {
          id: sessionID,
          slug: "test",
          projectID: Project.ID.global,
          directory: "/project",
          title: "test",
          version: "test",
          kind: "code",
          time: { created: 1, updated: 1 },
        },
      })

      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toBeUndefined()
      const tombstone = yield* db
        .select()
        .from(SessionTombstoneTable)
        .where(eq(SessionTombstoneTable.id, sessionID))
        .get()
      expect(tombstone?.time_deleted).toBeGreaterThanOrEqual(before)
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/session-tombstone.test.ts`
Expected: FAIL — `SyntaxError: Export named 'SessionTombstoneTable' not found in module '.../src/session/sql.ts'`.

- [ ] **Step 3: Add the table**

Append to `packages/core/src/session/sql.ts`:

```ts
// Machine sync: a deleted session leaves a tombstone so a paired machine
// deletes its copy instead of pulling the chat back. Tombstones older than 30
// days are pruned when the sync manifest is built.
export const SessionTombstoneTable = sqliteTable("session_tombstone", {
  id: text().$type<SessionSchema.ID>().primaryKey(),
  time_deleted: integer().notNull(),
})
```

- [ ] **Step 4: Generate the migration with the core generator**

Run: `cd packages/core && bun run migration --name session_tombstone`
Expected: a new file `src/database/migration/<YYYYMMDDHHMMSS>_session_tombstone.ts` plus rewritten `src/database/migration.gen.ts`, `src/database/schema.gen.ts` and `schema.json`. The migration body must be exactly one statement:

```ts
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "<YYYYMMDDHHMMSS>_session_tombstone",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_tombstone\` (
          \`id\` text PRIMARY KEY,
          \`time_deleted\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
```

If the generator emits anything else (for example statements for other tables), stop and fix `sql.ts` instead of editing generated files. Then run: `cd packages/core && bun script/migration.ts --check`
Expected: exits 0 with no output.

- [ ] **Step 5: Write the tombstone in the projector**

In `packages/core/src/session/projector.ts` change the import on line 15:

```ts
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  SessionTombstoneTable,
} from "./sql"
```

and replace the Deleted projector (lines 258-260):

```ts
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      Effect.gen(function* () {
        yield* db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie)
        // Machine sync reads this to delete the chat on the paired machine.
        const time_deleted = Date.now()
        yield* db
          .insert(SessionTombstoneTable)
          .values({ id: event.data.sessionID, time_deleted })
          .onConflictDoUpdate({ target: SessionTombstoneTable.id, set: { time_deleted } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/core && bun test test/session-tombstone.test.ts test/session-projector.test.ts test/database-migration.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 7: Typecheck**

Run: `cd packages/core && bun typecheck`
Expected: exits 0, no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/session/sql.ts packages/core/src/session/projector.ts packages/core/src/database packages/core/schema.json packages/core/test/session-tombstone.test.ts
git commit -m "$(cat <<'EOF'
feat(core): record session tombstones on delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: MachineSyncStore — manifest, bundle export, transactional apply

> **Amendment (reviewer):** `busy` must also be true when the session id is in `SessionExecution.Service.active` (V2 engine), not only from legacy `session.status` events. Add that service to the store's dependencies, combine both sources in `manifest()` and in the local-busy check used by apply, and add a test that marks a session active through a stub `SessionExecution` layer and expects `busy: true`.

**Files:**
- Create: `packages/opencode/src/machine-sync/store.ts`
- Test: `packages/opencode/test/machine-sync/store.test.ts`

**Interfaces:**
- Consumes: `Database.Service` (`@opencode-ai/core/database/database`), `FSUtil.Service` (`@opencode-ai/core/fs-util`), `Project.Service.fromDirectory(directory: string): Effect<{ project: Project.Info; sandbox: string }>` (`@/project/project`), `Session.fromRow(row)` (`@/session/session`), `GlobalBus` + `GlobalEvent` (`@/bus/global`), `migrations` (`@opencode-ai/core/database/migration.gen`), `InstallationVersion`, tables from Task 1.
- Produces (namespace `MachineSyncStore`, file self-exports `export * as MachineSyncStore from "./store"`):
  - `type ManifestSession = { id: string; parentID: string | null; timeUpdated: number; timeArchived: number | null; busy: boolean }`
  - `type Manifest = { schema: string; app: string; sessions: ManifestSession[]; tombstones: Array<{ id: string; timeDeleted: number }> }`
  - `type Bundle = { version: 1; session: SessionRow; project: ProjectRow | null; messages: MessageRow[]; parts: PartRow[]; todos: TodoRow[]; folders: FolderRow[]; inputs: InputRow[]; sessionMessages: SessionMessageRow[]; contextEpoch: ContextEpochRow | null; eventSequence: EventSequenceRow | null; events: EventRow[] }` (rows are `typeof <Table>.$inferSelect`)
  - `class BusyError` (`_tag: "MachineSyncBusyError"`, `{ sessionID: string }`), `class ApplyError` (`_tag: "MachineSyncApplyError"`, `{ sessionID: string; message: string }`)
  - `function isBundle(input: unknown): input is Bundle`
  - `interface Interface { manifest(): Effect<Manifest>; bundle(sessionID: SessionID): Effect<Bundle | undefined>; apply(bundle: Bundle): Effect<void, BusyError | ApplyError>; remove(input: { sessionID: SessionID; timeDeleted: number }): Effect<void, BusyError>; archive(input: { sessionID: SessionID; timeArchived: number }): Effect<void, BusyError>; missingDirectories(): Effect<string[]> }`
  - `class Service` (`"@opencode/MachineSyncStore"`), `const node` (deps `Database.node`, `FSUtil.node`, `Project.node`).

- [ ] **Step 1: Write the failing test**

Create `packages/opencode/test/machine-sync/store.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageTable, PartTable, SessionTable, SessionTombstoneTable } from "@opencode-ai/core/session/sql"
import { GlobalBus } from "@/bus/global"
import { MachineSyncStore } from "@/machine-sync/store"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([MachineSyncStore.node, Database.node])))
// A folder that never exists keeps the apply path off Project.fromDirectory.
const directory = "/nonexistent/flynncode-machine-sync"
const DAY = 24 * 60 * 60 * 1000

const seed = Effect.fn("test.machineSync.seed")(function* (id: string, time_updated = 10) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: SessionID.make(id),
      project_id: ProjectV2.ID.global,
      slug: id,
      directory,
      title: id,
      version: "test",
      time_created: 1,
      time_updated,
    })
    .run()
  yield* db
    .insert(MessageTable)
    .values({
      id: MessageID.make(`msg_${id}`),
      session_id: SessionID.make(id),
      time_created: 1,
      time_updated: 1,
      data: {
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      },
    })
    .run()
  yield* db
    .insert(PartTable)
    .values({
      id: PartID.make(`prt_${id}`),
      message_id: MessageID.make(`msg_${id}`),
      session_id: SessionID.make(id),
      time_created: 1,
      time_updated: 1,
      data: { type: "text", text: `hello ${id}` },
    })
    .run()
})

const status = (sessionID: string, type: "busy" | "idle") =>
  GlobalBus.emit("event", { payload: { type: "session.status", properties: { sessionID, status: { type } } } })

describe("MachineSyncStore", () => {
  it.effect("lists active and archived sessions and prunes tombstones older than 30 days", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_active", 20)
      yield* seed("ses_archived", 30)
      yield* db
        .update(SessionTable)
        .set({ time_archived: 40, time_updated: 30 })
        .where(eq(SessionTable.id, SessionID.make("ses_archived")))
        .run()
      yield* db
        .insert(SessionTombstoneTable)
        .values([
          { id: SessionID.make("ses_recent"), time_deleted: Date.now() - DAY },
          { id: SessionID.make("ses_old"), time_deleted: Date.now() - 31 * DAY },
        ])
        .run()

      const manifest = yield* store.manifest()

      expect(manifest.sessions.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "ses_active", parentID: null, timeUpdated: 20, timeArchived: null, busy: false },
        { id: "ses_archived", parentID: null, timeUpdated: 30, timeArchived: 40, busy: false },
      ])
      expect(manifest.tombstones.map((tombstone) => tombstone.id)).toEqual(["ses_recent"])
      expect(
        yield* db.select().from(SessionTombstoneTable).where(eq(SessionTombstoneTable.id, SessionID.make("ses_old"))).get(),
      ).toBeUndefined()
      expect(manifest.schema).not.toBe("none")
    }),
  )

  it.effect("marks sessions busy from session.status events", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_busy")
      status("ses_busy", "busy")
      expect((yield* store.manifest()).sessions[0]?.busy).toBe(true)
      status("ses_busy", "idle")
      expect((yield* store.manifest()).sessions[0]?.busy).toBe(false)
    }),
  )

  it.effect("exports a bundle without owner claims and applies a newer copy over the local chat", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_trip")
      yield* db.insert(EventSequenceTable).values({ aggregate_id: "ses_trip", seq: 3, owner_id: "owner-1" }).run()

      const exported = yield* store.bundle(SessionID.make("ses_trip"))
      if (!exported) return yield* Effect.die(new Error("seeded session missing"))
      expect(exported.eventSequence).toEqual({ aggregate_id: "ses_trip", seq: 3, owner_id: null })
      expect(exported.parts.map((part) => part.id)).toEqual(["prt_ses_trip"])

      yield* db
        .update(SessionTable)
        .set({ title: "changed locally" })
        .where(eq(SessionTable.id, SessionID.make("ses_trip")))
        .run()
      yield* store.apply({ ...exported, session: { ...exported.session, title: "from peer", time_updated: 99 } })

      const after = yield* store.bundle(SessionID.make("ses_trip"))
      expect(after?.session.title).toBe("from peer")
      expect(after?.session.time_updated).toBe(99)
      expect(after?.messages.map((message) => message.id)).toEqual(["msg_ses_trip"])
      expect(after?.parts.map((part) => part.data)).toEqual([{ type: "text", text: "hello ses_trip" }])
    }),
  )

  it.effect("leaves the local chat byte-identical when an apply fails", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_safe")
      const before = yield* store.bundle(SessionID.make("ses_safe"))
      if (!before) return yield* Effect.die(new Error("seeded session missing"))
      const part = before.parts[0]
      if (!part) return yield* Effect.die(new Error("seeded part missing"))

      const failure = yield* store
        .apply({
          ...before,
          session: { ...before.session, title: "must not land", time_updated: 500 },
          // The part points at a message that is not in the bundle, so the
          // foreign key fails after the local rows were already deleted.
          parts: [{ ...part, id: PartID.make("prt_orphan"), message_id: MessageID.make("msg_missing") }],
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("MachineSyncApplyError")
      expect(JSON.stringify(yield* store.bundle(SessionID.make("ses_safe")))).toBe(JSON.stringify(before))
    }),
  )

  it.effect("refuses to apply over or delete a running chat", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_running")
      const exported = yield* store.bundle(SessionID.make("ses_running"))
      if (!exported) return yield* Effect.die(new Error("seeded session missing"))
      status("ses_running", "busy")
      expect((yield* store.apply(exported).pipe(Effect.flip))._tag).toBe("MachineSyncBusyError")
      expect(
        (yield* store.remove({ sessionID: SessionID.make("ses_running"), timeDeleted: 1 }).pipe(Effect.flip))._tag,
      ).toBe("MachineSyncBusyError")
      status("ses_running", "idle")
    }),
  )

  it.effect("deletes with the peer's deletion time and archives without moving time_updated", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_gone")
      yield* seed("ses_shelved", 77)

      yield* store.remove({ sessionID: SessionID.make("ses_gone"), timeDeleted: 1234 })
      yield* store.archive({ sessionID: SessionID.make("ses_shelved"), timeArchived: 5678 })

      expect(yield* store.bundle(SessionID.make("ses_gone"))).toBeUndefined()
      expect(
        yield* db.select().from(SessionTombstoneTable).where(eq(SessionTombstoneTable.id, SessionID.make("ses_gone"))).get(),
      ).toEqual({ id: "ses_gone", time_deleted: 1234 })
      const shelved = yield* db.select().from(SessionTable).where(eq(SessionTable.id, SessionID.make("ses_shelved"))).get()
      expect({ archived: shelved?.time_archived, updated: shelved?.time_updated }).toEqual({ archived: 5678, updated: 77 })
    }),
  )

  it.effect("reports active chat folders that do not exist on this machine", () =>
    Effect.gen(function* () {
      const store = yield* MachineSyncStore.Service
      yield* seed("ses_missing")
      expect(yield* store.missingDirectories()).toEqual([directory])
    }),
  )

  it.effect("rejects malformed bundles", () =>
    Effect.sync(() => {
      expect(MachineSyncStore.isBundle({})).toBe(false)
      expect(MachineSyncStore.isBundle({ version: 1, session: { id: "not-a-session" } })).toBe(false)
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/opencode && bun test test/machine-sync/store.test.ts`
Expected: FAIL — `Cannot find module '@/machine-sync/store'`.

- [ ] **Step 3: Implement the store**

Create `packages/opencode/src/machine-sync/store.ts`:

```ts
export * as MachineSyncStore from "./store"

import { asc, eq, isNull, lt } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import {
  MessageTable,
  PartTable,
  SessionContextEpochTable,
  SessionFolderTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  SessionTombstoneTable,
  TodoTable,
} from "@opencode-ai/core/session/sql"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
// Large chats are inserted in chunks to stay far below SQLite's bound
// parameter limit.
const INSERT_CHUNK = 200
// Both machines must run the same database schema; the newest migration id
// names it.
const SCHEMA_VERSION =
  migrations
    .map((migration) => migration.id)
    .sort()
    .at(-1) ?? "none"

export type ManifestSession = {
  id: string
  parentID: string | null
  timeUpdated: number
  timeArchived: number | null
  busy: boolean
}

export type Manifest = {
  schema: string
  app: string
  sessions: ManifestSession[]
  tombstones: Array<{ id: string; timeDeleted: number }>
}

type SessionRow = typeof SessionTable.$inferSelect

export type Bundle = {
  version: 1
  session: SessionRow
  project: typeof ProjectTable.$inferSelect | null
  messages: Array<typeof MessageTable.$inferSelect>
  parts: Array<typeof PartTable.$inferSelect>
  todos: Array<typeof TodoTable.$inferSelect>
  folders: Array<typeof SessionFolderTable.$inferSelect>
  inputs: Array<typeof SessionInputTable.$inferSelect>
  sessionMessages: Array<typeof SessionMessageTable.$inferSelect>
  contextEpoch: typeof SessionContextEpochTable.$inferSelect | null
  eventSequence: typeof EventSequenceTable.$inferSelect | null
  events: Array<typeof EventTable.$inferSelect>
}

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("MachineSyncBusyError", {
  sessionID: Schema.String,
}) {}

export class ApplyError extends Schema.TaggedErrorClass<ApplyError>()("MachineSyncApplyError", {
  sessionID: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  /** Every session (archived ones carry `timeArchived`) plus tombstones from the last 30 days. */
  readonly manifest: () => Effect.Effect<Manifest>
  /** Everything that defines one chat; owner claims are cleared. */
  readonly bundle: (sessionID: SessionID) => Effect.Effect<Bundle | undefined>
  /** Replaces the local chat with the bundle in one transaction. */
  readonly apply: (bundle: Bundle) => Effect.Effect<void, BusyError | ApplyError>
  readonly remove: (input: { sessionID: SessionID; timeDeleted: number }) => Effect.Effect<void, BusyError>
  readonly archive: (input: { sessionID: SessionID; timeArchived: number }) => Effect.Effect<void, BusyError>
  /** Distinct folders of unarchived chats that do not exist on this machine. */
  readonly missingDirectories: () => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MachineSyncStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fs = yield* FSUtil.Service
    const project = yield* Project.Service

    // Session status is instance-scoped, but every status change crosses the
    // process-wide GlobalBus, so the set covers chats in every directory.
    const busy = new Set<string>()
    const track = (event: GlobalEvent) => {
      const payload: unknown = event.payload
      if (!isRecord(payload) || !isRecord(payload.properties)) return
      const sessionID = payload.properties.sessionID
      if (typeof sessionID !== "string") return
      if (payload.type === "session.idle") {
        busy.delete(sessionID)
        return
      }
      if (payload.type !== "session.status" || !isRecord(payload.properties.status)) return
      if (payload.properties.status.type === "idle") busy.delete(sessionID)
      if (payload.properties.status.type !== "idle") busy.add(sessionID)
    }
    GlobalBus.on("event", track)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", track)))

    const manifest = Effect.fn("MachineSyncStore.manifest")(function* () {
      yield* db
        .delete(SessionTombstoneTable)
        .where(lt(SessionTombstoneTable.time_deleted, Date.now() - TOMBSTONE_TTL_MS))
        .run()
        .pipe(Effect.orDie)
      const sessions = yield* db
        .select({
          id: SessionTable.id,
          parent_id: SessionTable.parent_id,
          time_updated: SessionTable.time_updated,
          time_archived: SessionTable.time_archived,
        })
        .from(SessionTable)
        .all()
        .pipe(Effect.orDie)
      const tombstones = yield* db.select().from(SessionTombstoneTable).all().pipe(Effect.orDie)
      // A session re-created under the same id (an import, a pulled chat)
      // outranks its old tombstone.
      const live = new Set(sessions.map((row) => row.id))
      return {
        schema: SCHEMA_VERSION,
        app: InstallationVersion,
        sessions: sessions.map((row) => ({
          id: row.id,
          parentID: row.parent_id ?? null,
          timeUpdated: row.time_updated,
          timeArchived: row.time_archived ?? null,
          busy: busy.has(row.id),
        })),
        tombstones: tombstones
          .filter((row) => !live.has(row.id))
          .map((row) => ({ id: row.id, timeDeleted: row.time_deleted })),
      } satisfies Manifest
    })

    const bundle = Effect.fn("MachineSyncStore.bundle")(function* (sessionID: SessionID) {
      const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!session) return undefined
      const projectRow = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, session.project_id))
        .get()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const contextEpoch = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return {
        version: 1,
        session,
        project: projectRow ?? null,
        messages: yield* db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.session_id, sessionID))
          .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
          .all()
          .pipe(Effect.orDie),
        parts: yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.session_id, sessionID))
          .orderBy(asc(PartTable.id))
          .all()
          .pipe(Effect.orDie),
        todos: yield* db
          .select()
          .from(TodoTable)
          .where(eq(TodoTable.session_id, sessionID))
          .orderBy(asc(TodoTable.position))
          .all()
          .pipe(Effect.orDie),
        folders: yield* db
          .select()
          .from(SessionFolderTable)
          .where(eq(SessionFolderTable.session_id, sessionID))
          .orderBy(asc(SessionFolderTable.position))
          .all()
          .pipe(Effect.orDie),
        inputs: yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID))
          .orderBy(asc(SessionInputTable.admitted_seq))
          .all()
          .pipe(Effect.orDie),
        sessionMessages: yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie),
        contextEpoch: contextEpoch ?? null,
        // Owner claims are process-local, so they never leave this machine.
        eventSequence: sequence ? { ...sequence, owner_id: null } : null,
        events: yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie),
      } satisfies Bundle
    })

    const apply = Effect.fn("MachineSyncStore.apply")(function* (input: Bundle) {
      const sessionID = input.session.id
      if (busy.has(sessionID)) return yield* new BusyError({ sessionID })
      // A chat whose folder is missing here is still stored and readable; it
      // keeps the peer's project row so the foreign key holds.
      const present = yield* fs.existsSafe(input.session.directory)
      const projectID = present
        ? (yield* project.fromDirectory(input.session.directory)).project.id
        : input.session.project_id
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (!present && input.project) yield* tx.insert(ProjectTable).values(input.project).onConflictDoNothing().run()
            yield* tx.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()
            yield* tx.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
            yield* tx.delete(SessionTombstoneTable).where(eq(SessionTombstoneTable.id, sessionID)).run()
            yield* tx.insert(SessionTable).values({ ...input.session, project_id: projectID }).run()
            yield* Effect.forEach(chunks(input.messages), (rows) => tx.insert(MessageTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(chunks(input.parts), (rows) => tx.insert(PartTable).values(rows).run(), { discard: true })
            yield* Effect.forEach(chunks(input.todos), (rows) => tx.insert(TodoTable).values(rows).run(), { discard: true })
            yield* Effect.forEach(chunks(input.folders), (rows) => tx.insert(SessionFolderTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(chunks(input.inputs), (rows) => tx.insert(SessionInputTable).values(rows).run(), {
              discard: true,
            })
            yield* Effect.forEach(
              chunks(input.sessionMessages),
              (rows) => tx.insert(SessionMessageTable).values(rows).run(),
              { discard: true },
            )
            if (input.contextEpoch) yield* tx.insert(SessionContextEpochTable).values(input.contextEpoch).run()
            if (input.eventSequence)
              yield* tx.insert(EventSequenceTable).values({ ...input.eventSequence, owner_id: null }).run()
            yield* Effect.forEach(chunks(input.events), (rows) => tx.insert(EventTable).values(rows).run(), {
              discard: true,
            })
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new ApplyError({ sessionID, message: cause instanceof Error ? cause.message : String(cause) }),
          ),
        )
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (row) emit("session.updated", row)
    })

    const remove = Effect.fn("MachineSyncStore.remove")(function* (input: {
      sessionID: SessionID
      timeDeleted: number
    }) {
      if (busy.has(input.sessionID)) return yield* new BusyError({ sessionID: input.sessionID })
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, input.sessionID)).run()
            yield* tx.delete(SessionTable).where(eq(SessionTable.id, input.sessionID)).run()
            yield* tx
              .insert(SessionTombstoneTable)
              .values({ id: input.sessionID, time_deleted: input.timeDeleted })
              .onConflictDoUpdate({ target: SessionTombstoneTable.id, set: { time_deleted: input.timeDeleted } })
              .run()
          }),
        )
        .pipe(Effect.orDie)
      if (row) emit("session.deleted", row)
    })

    const archive = Effect.fn("MachineSyncStore.archive")(function* (input: {
      sessionID: SessionID
      timeArchived: number
    }) {
      if (busy.has(input.sessionID)) return yield* new BusyError({ sessionID: input.sessionID })
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
      if (!row) return
      // time_updated has an $onUpdate default; pin it so archiving here does
      // not look like a newer local edit to the peer.
      yield* db
        .update(SessionTable)
        .set({ time_archived: input.timeArchived, time_updated: row.time_updated })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      emit("session.updated", { ...row, time_archived: input.timeArchived })
    })

    const missingDirectories = Effect.fn("MachineSyncStore.missingDirectories")(function* () {
      const rows = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(isNull(SessionTable.time_archived))
        .all()
        .pipe(Effect.orDie)
      const directories = [...new Set(rows.map((row) => row.directory))]
      const missing = yield* Effect.forEach(
        directories,
        (directory) => fs.existsSafe(directory).pipe(Effect.map((exists) => (exists ? undefined : directory))),
        { concurrency: 8 },
      )
      return missing.filter((directory): directory is string => directory !== undefined).sort()
    })

    return Service.of({ manifest, bundle, apply, remove, archive, missingDirectories })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, FSUtil.node, Project.node] })

export function isBundle(input: unknown): input is Bundle {
  if (!isRecord(input) || input.version !== 1 || !isRecord(input.session)) return false
  const session = input.session
  if (typeof session.id !== "string" || !session.id.startsWith("ses")) return false
  if (typeof session.project_id !== "string" || typeof session.directory !== "string") return false
  if (typeof session.time_updated !== "number") return false
  const owned = [input.messages, input.parts, input.todos, input.folders, input.inputs, input.sessionMessages]
  if (!owned.every((rows) => Array.isArray(rows) && rows.every((row) => isRecord(row) && row.session_id === session.id)))
    return false
  if (!Array.isArray(input.events) || !input.events.every((row) => isRecord(row) && row.aggregate_id === session.id))
    return false
  if (input.eventSequence !== null && !(isRecord(input.eventSequence) && input.eventSequence.aggregate_id === session.id))
    return false
  if (input.contextEpoch !== null && !(isRecord(input.contextEpoch) && input.contextEpoch.session_id === session.id))
    return false
  return input.project === null || (isRecord(input.project) && input.project.id === session.project_id)
}

function chunks<T>(rows: readonly T[]) {
  return Array.from({ length: Math.ceil(rows.length / INSERT_CHUNK) }, (_, index) =>
    rows.slice(index * INSERT_CHUNK, (index + 1) * INSERT_CHUNK),
  )
}

// Sync writes bypass the event log, so the UI hears about them through the
// same GlobalBus channel the SSE stream already forwards.
function emit(type: "session.updated" | "session.deleted", row: SessionRow) {
  GlobalBus.emit("event", {
    directory: row.directory,
    project: row.project_id,
    payload: { type, properties: { sessionID: row.id, info: Session.fromRow(row) } },
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/machine-sync/store.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `cd packages/opencode && bun typecheck`
Expected: exits 0. If `tx.insert(X).values(rows)` rejects `$inferSelect` rows for a table, the mismatch is a real schema drift — fix the `Bundle` row type for that table to `typeof X.$inferInsert`, never with `as`.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/machine-sync/store.ts packages/opencode/test/machine-sync/store.test.ts
git commit -m "$(cat <<'EOF'
feat(opencode): add machine sync store for chat bundles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Per-chat sync decision

**Files:**
- Create: `packages/mobile-gateway/src/sync-decide.ts`
- Test: `packages/mobile-gateway/test/sync-decide.test.ts`

**Interfaces:**
- Consumes: the manifest JSON shape produced by `MachineSyncStore.manifest()` (Task 2). The gateway package does not import `packages/opencode`, so the shape is redeclared here and guarded at runtime.
- Produces:
  - `type ManifestSession = { id: string; parentID: string | null; timeUpdated: number; timeArchived: number | null; busy: boolean }`
  - `type Manifest = { schema: string; app: string; sessions: ManifestSession[]; tombstones: Array<{ id: string; timeDeleted: number }> }`
  - `type SyncAction = { type: "pull"; id: string } | { type: "delete"; id: string; timeDeleted: number } | { type: "archive"; id: string; timeArchived: number } | { type: "skip"; id: string; reason: "local-busy" | "peer-busy" }`
  - `function decide(input: { local: Manifest; peer: Manifest }): SyncAction[]` — deletes first, then pulls ordered parent-before-child, then archives and skips.
  - `function isManifest(value: unknown): value is Manifest`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/sync-decide.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { decide, isManifest, type Manifest, type ManifestSession } from "../src/sync-decide.ts"

const manifest = (sessions: ManifestSession[], tombstones: Manifest["tombstones"] = []): Manifest => ({
  schema: "20261008_session_tombstone",
  app: "1.18.34",
  sessions,
  tombstones,
})

const session = (id: string, timeUpdated: number, extra: Partial<ManifestSession> = {}): ManifestSession => ({
  id,
  parentID: null,
  timeUpdated,
  timeArchived: null,
  busy: false,
  ...extra,
})

describe("decide", () => {
  test("pulls chats that are newer on the peer or missing here, keeps equal and older ones", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10), session("ses_b", 10), session("ses_c", 30)]),
      peer: manifest([session("ses_a", 20), session("ses_b", 10), session("ses_c", 20), session("ses_d", 5)]),
    })
    expect(actions).toEqual([
      { type: "pull", id: "ses_a" },
      { type: "pull", id: "ses_d" },
    ])
  })

  test("skips a chat that is running here or on the peer", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10, { busy: true }), session("ses_b", 10)]),
      peer: manifest([session("ses_a", 20), session("ses_b", 20, { busy: true })]),
    })
    expect(actions).toEqual([
      { type: "skip", id: "ses_a", reason: "local-busy" },
      { type: "skip", id: "ses_b", reason: "peer-busy" },
    ])
  })

  test("deletes when the peer's tombstone is newer than the local copy", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10), session("ses_b", 50)]),
      peer: manifest([], [
        { id: "ses_a", timeDeleted: 20 },
        { id: "ses_b", timeDeleted: 20 },
        { id: "ses_gone", timeDeleted: 20 },
      ]),
    })
    expect(actions).toEqual([{ type: "delete", id: "ses_a", timeDeleted: 20 }])
  })

  test("does not pull back a chat deleted here after the peer's last change", () => {
    const actions = decide({
      local: manifest([], [{ id: "ses_a", timeDeleted: 30 }]),
      peer: manifest([session("ses_a", 20), session("ses_b", 40)]),
    })
    expect(actions).toEqual([{ type: "pull", id: "ses_b" }])
  })

  test("archives when the peer archived later, never pulls archived chats that are missing here", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10), session("ses_b", 50)]),
      peer: manifest([
        session("ses_a", 10, { timeArchived: 30 }),
        session("ses_b", 50, { timeArchived: 40 }),
        session("ses_c", 10, { timeArchived: 30 }),
      ]),
    })
    expect(actions).toEqual([{ type: "archive", id: "ses_a", timeArchived: 30 }])
  })

  test("pulls a chat archived here earlier than the peer's newer copy", () => {
    const actions = decide({
      local: manifest([session("ses_a", 10, { timeArchived: 15 })]),
      peer: manifest([session("ses_a", 20)]),
    })
    expect(actions).toEqual([{ type: "pull", id: "ses_a" }])
  })

  test("applies parents before children", () => {
    const actions = decide({
      local: manifest([]),
      peer: manifest([
        session("ses_grandchild", 3, { parentID: "ses_child" }),
        session("ses_child", 2, { parentID: "ses_root" }),
        session("ses_root", 1),
      ]),
    })
    expect(actions.map((action) => action.id)).toEqual(["ses_root", "ses_child", "ses_grandchild"])
  })
})

describe("isManifest", () => {
  test("accepts a manifest and rejects malformed input", () => {
    expect(isManifest(manifest([session("ses_a", 1)], [{ id: "ses_b", timeDeleted: 2 }]))).toBe(true)
    expect(isManifest({ schema: "x", app: "y", sessions: [{ id: "ses_a" }], tombstones: [] })).toBe(false)
    expect(isManifest(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile-gateway && bun test test/sync-decide.test.ts`
Expected: FAIL — `Cannot find module '../src/sync-decide.ts'`.

- [ ] **Step 3: Implement the decision**

Create `packages/mobile-gateway/src/sync-decide.ts`:

```ts
export type ManifestSession = {
  id: string
  parentID: string | null
  timeUpdated: number
  timeArchived: number | null
  busy: boolean
}

export type Manifest = {
  schema: string
  app: string
  sessions: ManifestSession[]
  tombstones: Array<{ id: string; timeDeleted: number }>
}

export type SyncAction =
  | { type: "pull"; id: string }
  | { type: "delete"; id: string; timeDeleted: number }
  | { type: "archive"; id: string; timeArchived: number }
  | { type: "skip"; id: string; reason: "local-busy" | "peer-busy" }

type Change = Exclude<SyncAction, { type: "skip" }>

// Newest whole-chat copy wins; equal keeps local. Each machine only ever
// writes its own database, so this decides what to pull from the peer.
export function decide(input: { local: Manifest; peer: Manifest }): SyncAction[] {
  const local = new Map(input.local.sessions.map((session) => [session.id, session]))
  const deletedHere = new Map(input.local.tombstones.map((tombstone) => [tombstone.id, tombstone.timeDeleted]))
  const peer = new Map(input.peer.sessions.map((session) => [session.id, session]))

  const deletes = input.peer.tombstones.flatMap((tombstone): SyncAction[] => {
    const current = local.get(tombstone.id)
    if (!current || tombstone.timeDeleted <= current.timeUpdated) return []
    return [guard({ type: "delete", id: tombstone.id, timeDeleted: tombstone.timeDeleted }, current, undefined)]
  })
  const changes = input.peer.sessions.flatMap((remote): SyncAction[] => {
    const change = sessionChange(remote, local.get(remote.id), deletedHere.get(remote.id))
    return change ? [guard(change, local.get(remote.id), remote)] : []
  })
  const pulls = parentsFirst(
    changes.filter((action): action is { type: "pull"; id: string } => action.type === "pull"),
    peer,
  )
  return [...deletes, ...pulls, ...changes.filter((action) => action.type !== "pull")]
}

function sessionChange(
  remote: ManifestSession,
  current: ManifestSession | undefined,
  deletedAt: number | undefined,
): Change | undefined {
  if (remote.timeArchived !== null) {
    // Archived chats stay local: only an existing active copy follows the archive.
    if (!current || current.timeArchived !== null) return
    if (remote.timeArchived <= current.timeUpdated) return
    return { type: "archive", id: remote.id, timeArchived: remote.timeArchived }
  }
  if (deletedAt !== undefined && deletedAt >= remote.timeUpdated) return
  if (!current) return { type: "pull", id: remote.id }
  if (current.timeArchived !== null) return remote.timeUpdated > current.timeArchived ? { type: "pull", id: remote.id } : undefined
  return remote.timeUpdated > current.timeUpdated ? { type: "pull", id: remote.id } : undefined
}

function guard(change: Change, current: ManifestSession | undefined, remote: ManifestSession | undefined): SyncAction {
  if (current?.busy) return { type: "skip", id: change.id, reason: "local-busy" }
  if (remote?.busy) return { type: "skip", id: change.id, reason: "peer-busy" }
  return change
}

function parentsFirst(pulls: Array<{ type: "pull"; id: string }>, peer: Map<string, ManifestSession>) {
  const pending = new Map(pulls.map((action) => [action.id, action]))
  const ordered: Array<{ type: "pull"; id: string }> = []
  const visit = (id: string, seen: Set<string>) => {
    const action = pending.get(id)
    if (!action || seen.has(id)) return
    seen.add(id)
    const parentID = peer.get(id)?.parentID
    if (parentID) visit(parentID, seen)
    pending.delete(id)
    ordered.push(action)
  }
  pulls.forEach((action) => visit(action.id, new Set()))
  return ordered
}

export function isManifest(value: unknown): value is Manifest {
  if (!isRecord(value) || typeof value.schema !== "string" || typeof value.app !== "string") return false
  if (!Array.isArray(value.sessions) || !Array.isArray(value.tombstones)) return false
  return (
    value.sessions.every(isManifestSession) &&
    value.tombstones.every(
      (tombstone) => isRecord(tombstone) && typeof tombstone.id === "string" && typeof tombstone.timeDeleted === "number",
    )
  )
}

function isManifestSession(value: unknown): value is ManifestSession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.timeUpdated === "number" &&
    typeof value.busy === "boolean" &&
    (value.parentID === null || typeof value.parentID === "string") &&
    (value.timeArchived === null || typeof value.timeArchived === "number")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/mobile-gateway && bun test test/sync-decide.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `cd packages/mobile-gateway && bun typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile-gateway/src/sync-decide.ts packages/mobile-gateway/test/sync-decide.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile-gateway): decide which chats to pull from a sync peer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Server sync routes for chats

**Files:**
- Create: `packages/opencode/src/server/routes/instance/httpapi/machine-sync.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts` (imports near line 130; route constants after `uiRoute` ~line 218; `Layer.mergeAll(...)` in `createRoutes` ~line 305; `app` group ~line 227-294)
- Test: `packages/opencode/test/server/httpapi-machine-sync.test.ts`

**Interfaces:**
- Consumes: `MachineSyncStore.Service`, `MachineSyncStore.isBundle`, `SessionID` schema (`@/session/schema`), `HttpRouter.use/params`, `HttpServerResponse.jsonUnsafe`, `authorizationRouterMiddleware` (server Basic auth, via `authOnlyRouterLayer` already defined in `server.ts`).
- Produces: `export const MachineSyncPaths = { manifest: "/flynncode-sync/manifest", session: "/flynncode-sync/session/:id", apply: "/flynncode-sync/apply", delete: "/flynncode-sync/delete/:id", archive: "/flynncode-sync/archive/:id", missing: "/flynncode-sync/missing", settings: "/flynncode-sync/settings", settingsApply: "/flynncode-sync/settings/apply" } as const` and `export const machineSyncRoutes` (raw routes layer). HTTP contract:
  - `GET manifest` → 200 `Manifest`
  - `GET session/:id` → 200 `Bundle` | 404
  - `POST apply` body `Bundle` → 200 `{ ok: true }` | 400 `{ error }` | 409 `{ error: "busy" }` | 422 `{ error }`
  - `POST delete/:id` body `{ timeDeleted: number }` → 200 `{ ok: true }` | 400 | 409
  - `POST archive/:id` body `{ timeArchived: number }` → 200 `{ ok: true }` | 400 | 409
  - `GET missing` → 200 `{ directories: string[] }`
  - (`settings`, `settingsApply` are added in Task 5)

- [ ] **Step 1: Write the failing test**

Create `packages/opencode/test/server/httpapi-machine-sync.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { MachineSyncStore } from "@/machine-sync/store"
import { MachineSyncPaths, machineSyncRoutes } from "@/server/routes/instance/httpapi/machine-sync"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// The routes are served alone (no auth layer) on the in-test server; the app
// graph is provided once so the routes and the test share one database.
const appLayer = AppNodeBuilder.build(LayerNode.group([MachineSyncStore.node, Database.node]))
const served = HttpRouter.serve(machineSyncRoutes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(appLayer),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(served)

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const seed = Effect.fn("test.machineSyncRoutes.seed")(function* (id: string) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: SessionID.make(id),
      project_id: ProjectV2.ID.global,
      slug: id,
      directory: "/nonexistent/flynncode-sync-route",
      title: id,
      version: "test",
      time_created: 1,
      time_updated: 10,
    })
    .run()
})

describe("machine sync routes", () => {
  it.live("serves the manifest and session bundles", () =>
    Effect.gen(function* () {
      yield* seed("ses_route")
      const manifest = yield* request(MachineSyncPaths.manifest)
      expect(manifest.status).toBe(200)
      const body = (yield* manifest.json) as { sessions: Array<{ id: string }> }
      expect(body.sessions.map((session) => session.id)).toEqual(["ses_route"])

      const bundle = yield* request("/flynncode-sync/session/ses_route")
      expect(bundle.status).toBe(200)
      expect(((yield* bundle.json) as { session: { title: string } }).session.title).toBe("ses_route")
      expect((yield* request("/flynncode-sync/session/ses_unknown")).status).toBe(404)
      expect((yield* request("/flynncode-sync/session/not-a-session")).status).toBe(404)
    }),
  )

  it.live("rejects malformed bundles and applies valid ones", () =>
    Effect.gen(function* () {
      yield* seed("ses_apply")
      expect((yield* request(MachineSyncPaths.apply, post({ version: 1 }))).status).toBe(400)

      const exported = (yield* (yield* request("/flynncode-sync/session/ses_apply")).json) as {
        session: Record<string, unknown>
      }
      const applied = yield* request(
        MachineSyncPaths.apply,
        post({ ...exported, session: { ...exported.session, title: "from peer", time_updated: 50 } }),
      )
      expect(applied.status).toBe(200)
      const after = (yield* (yield* request("/flynncode-sync/session/ses_apply")).json) as {
        session: { title: string; time_updated: number }
      }
      expect(after.session).toMatchObject({ title: "from peer", time_updated: 50 })
    }),
  )

  it.live("deletes and archives through the local routes", () =>
    Effect.gen(function* () {
      yield* seed("ses_delete")
      yield* seed("ses_archive")
      expect((yield* request("/flynncode-sync/delete/ses_delete", post({ timeDeleted: Date.now() }))).status).toBe(200)
      expect((yield* request("/flynncode-sync/archive/ses_archive", post({ timeArchived: 77 }))).status).toBe(200)
      expect((yield* request("/flynncode-sync/archive/ses_archive", post({}))).status).toBe(400)

      const manifest = (yield* (yield* request(MachineSyncPaths.manifest)).json) as {
        sessions: Array<{ id: string; timeArchived: number | null }>
        tombstones: Array<{ id: string }>
      }
      expect(manifest.sessions).toEqual([expect.objectContaining({ id: "ses_archive", timeArchived: 77 })])
      expect(manifest.tombstones.map((tombstone) => tombstone.id)).toEqual(["ses_delete"])
    }),
  )

  it.live("lists missing folders", () =>
    Effect.gen(function* () {
      yield* seed("ses_missing")
      const response = yield* request(MachineSyncPaths.missing)
      expect(yield* response.json).toEqual({ directories: ["/nonexistent/flynncode-sync-route"] })
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/opencode && bun test test/server/httpapi-machine-sync.test.ts`
Expected: FAIL — `Cannot find module '@/server/routes/instance/httpapi/machine-sync'`.

- [ ] **Step 3: Implement the routes**

Create `packages/opencode/src/server/routes/instance/httpapi/machine-sync.ts`:

```ts
import { Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { MachineSyncStore } from "@/machine-sync/store"
import { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"

export const MachineSyncPaths = {
  manifest: "/flynncode-sync/manifest",
  session: "/flynncode-sync/session/:id",
  apply: "/flynncode-sync/apply",
  delete: "/flynncode-sync/delete/:id",
  archive: "/flynncode-sync/archive/:id",
  missing: "/flynncode-sync/missing",
  settings: "/flynncode-sync/settings",
  settingsApply: "/flynncode-sync/settings/apply",
} as const

const decodeSessionID = Schema.decodeUnknownOption(SessionID)

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })

// Machine sync is Flynncode-internal: the LAN gateway forwards only the
// read-only manifest/session/settings routes for a pairing-token peer, and the
// local sync worker calls the rest over loopback. Keeping them as raw routes
// leaves the public HttpApi and the generated SDK untouched.
export const machineSyncRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* MachineSyncStore.Service

    yield* router.add("GET", MachineSyncPaths.manifest, () => store.manifest().pipe(Effect.map((manifest) => json(manifest))))

    yield* router.add("GET", MachineSyncPaths.session, () =>
      Effect.gen(function* () {
        const sessionID = decodeSessionID((yield* HttpRouter.params).id)
        if (Option.isNone(sessionID)) return json({ error: "not found" }, 404)
        const bundle = yield* store.bundle(sessionID.value)
        if (!bundle) return json({ error: "not found" }, 404)
        return json(bundle)
      }),
    )

    yield* router.add("POST", MachineSyncPaths.apply, (request) =>
      Effect.gen(function* () {
        const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (!MachineSyncStore.isBundle(body)) return json({ error: "invalid bundle" }, 400)
        return yield* store.apply(body).pipe(
          Effect.as(json({ ok: true })),
          Effect.catchTag("MachineSyncBusyError", () => Effect.succeed(json({ error: "busy" }, 409))),
          Effect.catchTag("MachineSyncApplyError", (error) => Effect.succeed(json({ error: error.message }, 422))),
        )
      }),
    )

    yield* router.add("POST", MachineSyncPaths.delete, (request) =>
      Effect.gen(function* () {
        const sessionID = decodeSessionID((yield* HttpRouter.params).id)
        const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (Option.isNone(sessionID) || !isRecord(body) || typeof body.timeDeleted !== "number")
          return json({ error: "bad request" }, 400)
        return yield* store.remove({ sessionID: sessionID.value, timeDeleted: body.timeDeleted }).pipe(
          Effect.as(json({ ok: true })),
          Effect.catchTag("MachineSyncBusyError", () => Effect.succeed(json({ error: "busy" }, 409))),
        )
      }),
    )

    yield* router.add("POST", MachineSyncPaths.archive, (request) =>
      Effect.gen(function* () {
        const sessionID = decodeSessionID((yield* HttpRouter.params).id)
        const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (Option.isNone(sessionID) || !isRecord(body) || typeof body.timeArchived !== "number")
          return json({ error: "bad request" }, 400)
        return yield* store.archive({ sessionID: sessionID.value, timeArchived: body.timeArchived }).pipe(
          Effect.as(json({ ok: true })),
          Effect.catchTag("MachineSyncBusyError", () => Effect.succeed(json({ error: "busy" }, 409))),
        )
      }),
    )

    yield* router.add("GET", MachineSyncPaths.missing, () =>
      store.missingDirectories().pipe(Effect.map((directories) => json({ directories }))),
    )
  }),
)
```

- [ ] **Step 4: Mount the routes and the store in the server**

In `packages/opencode/src/server/routes/instance/httpapi/server.ts`:

1. Add imports next to the other handler imports (after `import { workspaceHandlers } from "./handlers/workspace"`):

```ts
import { MachineSyncStore } from "@/machine-sync/store"
import { machineSyncRoutes } from "./machine-sync"
```

2. After the `uiRoute` constant add:

```ts
// Machine sync routes use the server's Basic auth; the LAN gateway is the only
// path from another machine and it holds the server credential.
const machineSyncRoute = machineSyncRoutes.pipe(Layer.provide(authOnlyRouterLayer))
```

3. In the `app` `LayerNode.group([...])` list add `MachineSyncStore.node,` directly after `SessionFolders.node,`.

4. In `createRoutes`, `Layer.mergeAll(...)` becomes:

```ts
  return Layer.mergeAll(
    rootApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    machineSyncRoute,
    uiRoute,
  ).pipe(
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/server/httpapi-machine-sync.test.ts test/server/httpapi-ui.test.ts test/server/httpapi-authorization.test.ts`
Expected: PASS (new tests green; UI fallback and auth tests still green).

- [ ] **Step 6: Typecheck**

Run: `cd packages/opencode && bun typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/machine-sync.ts packages/opencode/src/server/routes/instance/httpapi/server.ts packages/opencode/test/server/httpapi-machine-sync.test.ts
git commit -m "$(cat <<'EOF'
feat(opencode): serve machine sync routes for chats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Global config sync with secret filtering

**Files:**
- Create: `packages/opencode/src/machine-sync/config-sync.ts`
- Modify: `packages/opencode/src/config/config.ts` (line 149 `function globalConfigFile()`; add `validateText` right after it)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/machine-sync.ts` (add the two settings routes)
- Test: `packages/opencode/test/machine-sync/config-sync.test.ts`; modify `packages/opencode/test/server/httpapi-machine-sync.test.ts`

**Interfaces:**
- Consumes: `ConfigParse.jsonc(text, file): unknown`, `ConfigParse.schema`, `ConfigV1.Info`, `ConfigV2Compat.lower`, `normalizeLoadedConfig` (all already in `config.ts`), `modify`/`applyEdits` from `jsonc-parser`, `FSUtil.Service` (`readFileStringSafe`, `stat`, `writeWithDirs`, `utimes`), `Config.Service.invalidate()`.
- Produces:
  - `Config.globalConfigFile(): string` (now exported), `Config.validateText(text: string, file: string): ConfigV1.Info` (throws `InvalidError`/`JsonError` on bad input)
  - `MachineSyncConfig.SECRET_PLACEHOLDER = "__flynncode_sync_secret__"`, `MachineSyncConfig.isSecretPath(path: readonly string[]): boolean`, `MachineSyncConfig.sanitizeConfig(input: unknown): Record<string, unknown>`, `MachineSyncConfig.applyPeerConfig(input: { localText: string; local: unknown; peer: Record<string, unknown> }): string`
  - Routes: `GET /flynncode-sync/settings` → `{ config: Record<string, unknown> | null; mtime: number }`; `POST /flynncode-sync/settings/apply` body `{ config: Record<string, unknown>; mtime: number }` → `{ applied: boolean }` | 400 | 422 `{ error }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/opencode/test/machine-sync/config-sync.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { MachineSyncConfig } from "@/machine-sync/config-sync"

const localText = `{
  // providers on this machine
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-old",
  "server": { "port": 4096 },
  "provider": {
    "anthropic": { "options": { "apiKey": "sk-local", "baseURL": "https://api.anthropic.com" } }
  },
  "mcp": {
    "github": { "type": "remote", "url": "https://mcp.example", "headers": { "Authorization": "Bearer local" } }
  }
}
`

describe("MachineSyncConfig.sanitizeConfig", () => {
  test("never sends secrets, references, auth headers, or the server block", () => {
    const sent = MachineSyncConfig.sanitizeConfig({
      model: "anthropic/claude",
      server: { port: 4096, password: "pw-server" },
      provider: {
        anthropic: { options: { apiKey: "sk-ant", baseURL: "{env:BASE_URL}", headers: { "X-Org": "org-1" } } },
      },
      mcp: {
        github: {
          type: "remote",
          url: "https://mcp.example",
          headers: { Authorization: "Bearer gh" },
          environment: { GITHUB_TOKEN: "ghp-1" },
        },
      },
      plugin_secret: "plain-secret",
      instructions: ["{file:~/notes.md}", "AGENTS.md"],
    })
    const text = JSON.stringify(sent)
    for (const secret of ["sk-ant", "{env:BASE_URL}", "org-1", "Bearer gh", "ghp-1", "plain-secret", "{file:~/notes.md}", "pw-server"])
      expect(text).not.toContain(secret)
    expect(sent.server).toBeUndefined()
    expect(sent.model).toBe("anthropic/claude")
    expect(sent.plugin_secret).toBe(MachineSyncConfig.SECRET_PLACEHOLDER)
    expect(sent.instructions).toEqual([MachineSyncConfig.SECRET_PLACEHOLDER, "AGENTS.md"])
  })
})

describe("MachineSyncConfig.applyPeerConfig", () => {
  const peer = MachineSyncConfig.sanitizeConfig({
    $schema: "https://opencode.ai/config.json",
    model: "anthropic/claude-new",
    server: { port: 9999 },
    provider: {
      anthropic: { options: { apiKey: "sk-peer", baseURL: "https://api.anthropic.com" } },
      openai: { options: { apiKey: "sk-openai" } },
    },
    mcp: { github: { type: "remote", url: "https://mcp.example", headers: { Authorization: "Bearer peer" } } },
  })
  const next = MachineSyncConfig.applyPeerConfig({
    localText,
    local: ConfigParse.jsonc(localText, "opencode.jsonc"),
    peer,
  })

  test("takes the peer's values and keeps comments", () => {
    expect(next).toContain("anthropic/claude-new")
    expect(next).toContain("// providers on this machine")
  })

  test("keeps local secrets and the local server block", () => {
    expect(next).toContain("sk-local")
    expect(next).toContain("Bearer local")
    expect(next).toContain("4096")
    expect(next).not.toContain("9999")
  })

  test("never writes placeholders and leaves peer-only secrets absent", () => {
    expect(next).not.toContain(MachineSyncConfig.SECRET_PLACEHOLDER)
    expect(next).not.toContain("sk-peer")
    expect(next).not.toContain("sk-openai")
    expect(ConfigParse.jsonc(next, "opencode.jsonc")).toMatchObject({ provider: { openai: { options: {} } } })
  })

  test("removes keys the peer dropped but never drops a local secret", () => {
    const trimmed = MachineSyncConfig.applyPeerConfig({
      localText,
      local: ConfigParse.jsonc(localText, "opencode.jsonc"),
      peer: { model: "anthropic/claude-new" },
    })
    expect(trimmed).not.toContain("https://mcp.example")
    expect(trimmed).not.toContain("baseURL")
    expect(trimmed).toContain("sk-local")
    expect(trimmed).toContain("Bearer local")
  })
})

describe("Config.validateText", () => {
  test("accepts a valid config and rejects an invalid one", () => {
    expect(() => Config.validateText(`{ "model": "anthropic/claude" }`, "opencode.jsonc")).not.toThrow()
    expect(() => Config.validateText(`{ "model": 42 }`, "opencode.jsonc")).toThrow()
  })
})
```

In `packages/opencode/test/server/httpapi-machine-sync.test.ts`:

1. Add imports:

```ts
import { rm, stat, utimes } from "node:fs/promises"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { MachineSyncConfig } from "@/machine-sync/config-sync"
```

2. Change the app layer so the settings routes have their services:

```ts
const appLayer = AppNodeBuilder.build(
  LayerNode.group([MachineSyncStore.node, Database.node, Config.node, FSUtil.node]),
)
```

3. Append inside `describe("machine sync routes", …)`:

```ts
  it.live("sends the global config without secrets and applies only a newer peer config", () =>
    Effect.gen(function* () {
      const file = Config.globalConfigFile()
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
      yield* Effect.promise(() =>
        Bun.write(
          file,
          `{\n  // keep me\n  "model": "local/model",\n  "provider": { "anthropic": { "options": { "apiKey": "sk-local" } } }\n}\n`,
        ),
      )
      yield* Effect.promise(() => utimes(file, new Date(1_000), new Date(1_000)))

      const sent = (yield* (yield* request(MachineSyncPaths.settings)).json) as {
        config: Record<string, unknown>
        mtime: number
      }
      expect(JSON.stringify(sent.config)).not.toContain("sk-local")
      expect(sent.mtime).toBe(1_000)

      const stale = yield* request(MachineSyncPaths.settingsApply, post({ config: { model: "peer/old" }, mtime: 500 }))
      expect(yield* stale.json).toEqual({ applied: false })

      const fresh = yield* request(
        MachineSyncPaths.settingsApply,
        post({
          config: {
            model: "peer/new",
            provider: { anthropic: { options: { apiKey: MachineSyncConfig.SECRET_PLACEHOLDER } } },
          },
          mtime: 2_000,
        }),
      )
      expect(yield* fresh.json).toEqual({ applied: true })
      const text = yield* Effect.promise(() => Bun.file(file).text())
      expect(text).toContain("// keep me")
      expect(text).toContain("peer/new")
      expect(text).toContain("sk-local")
      expect(text).not.toContain(MachineSyncConfig.SECRET_PLACEHOLDER)
      expect((yield* Effect.promise(() => stat(file))).mtimeMs).toBe(2_000)
    }),
  )

  it.live("reports a peer config that fails validation without writing it", () =>
    Effect.gen(function* () {
      const file = Config.globalConfigFile()
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
      yield* Effect.promise(() => Bun.write(file, `{ "model": "local/model" }\n`))
      yield* Effect.promise(() => utimes(file, new Date(1_000), new Date(1_000)))
      const response = yield* request(MachineSyncPaths.settingsApply, post({ config: { model: 42 }, mtime: 2_000 }))
      expect(response.status).toBe(422)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toContain("local/model")
    }),
  )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/machine-sync/config-sync.test.ts test/server/httpapi-machine-sync.test.ts`
Expected: FAIL — `Cannot find module '@/machine-sync/config-sync'`.

- [ ] **Step 3: Export the config helpers**

In `packages/opencode/src/config/config.ts` replace line 149 `function globalConfigFile() {` with `export function globalConfigFile() {` and add directly after the end of that function:

```ts
// Machine sync validates a patched global config with the normal schema
// before it is written. Throws the same errors as loading the file.
export function validateText(text: string, file: string) {
  return ConfigParse.schema(
    ConfigV1.Info,
    ConfigV2Compat.lower(normalizeLoadedConfig(ConfigParse.jsonc(text, file)), file).value,
    file,
  )
}
```

- [ ] **Step 4: Implement the config sync module**

Create `packages/opencode/src/machine-sync/config-sync.ts`:

```ts
export * as MachineSyncConfig from "./config-sync"

import { applyEdits, modify } from "jsonc-parser"
import { isRecord } from "@/util/record"

export const SECRET_PLACEHOLDER = "__flynncode_sync_secret__"

const SECRET_KEY = /(apiKey|api_key|token|secret|password)$/i
const REFERENCE = /\{(env|file):[^}]*\}/
const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } }

export function isSecretPath(path: readonly string[]) {
  const key = path.at(-1)
  if (key !== undefined && SECRET_KEY.test(key)) return true
  // Any value inside a provider or MCP headers map can carry credentials.
  return (path[0] === "provider" || path[0] === "mcp") && path.slice(0, -1).includes("headers")
}

/** The global config as it may leave this machine: secrets masked, no server block. */
export function sanitizeConfig(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {}
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key !== "server")
      .map(([key, value]) => [key, mask(value, [key])]),
  )
}

/**
 * Rewrites `localText` into the peer's config with jsonc edits so comments in
 * untouched regions survive. Local secret leaves and the local server block
 * always stay; peer placeholders never land; a secret only the peer has stays
 * absent.
 */
export function applyPeerConfig(input: { localText: string; local: unknown; peer: Record<string, unknown> }): string {
  const local = isRecord(input.local) ? input.local : {}
  const restored = restore(input.peer, local, [])
  const target = Object.fromEntries(
    Object.entries(isRecord(restored?.value) ? restored.value : {}).filter(([key]) => key !== "server"),
  )
  const next = local.server === undefined ? target : { ...target, server: local.server }
  return patchTo(input.localText.trim() ? input.localText : "{}", [], local, next)
}

function mask(value: unknown, path: string[]): unknown {
  if (isSecretPath(path) || isReference(value)) return SECRET_PLACEHOLDER
  if (Array.isArray(value)) return value.map((item, index) => mask(item, [...path, String(index)]))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item, [...path, key])]))
  return value
}

function restore(peer: unknown, local: unknown, path: string[]): { value: unknown } | undefined {
  if (isSecretPath(path) || peer === SECRET_PLACEHOLDER) return local === undefined ? undefined : { value: local }
  if (Array.isArray(peer)) {
    if (!peer.some((item) => item === SECRET_PLACEHOLDER)) return { value: peer }
    return local === undefined ? undefined : { value: local }
  }
  if (!isRecord(peer)) return { value: peer }
  const base = isRecord(local) ? local : {}
  const incoming = Object.entries(peer).flatMap(([key, value]) => {
    const next = restore(value, base[key], [...path, key])
    return next ? [[key, next.value] as const] : []
  })
  // Keys the peer no longer has go away, except the local secrets inside them.
  const kept = Object.entries(base)
    .filter(([key]) => !Object.hasOwn(peer, key))
    .flatMap(([key, value]) => {
      const secrets = secretsOnly(value, [...path, key])
      return secrets ? [[key, secrets.value] as const] : []
    })
  return { value: Object.fromEntries([...incoming, ...kept]) }
}

function secretsOnly(value: unknown, path: string[]): { value: unknown } | undefined {
  if (isSecretPath(path) || isReference(value)) return { value }
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).flatMap(([key, item]) => {
    const secrets = secretsOnly(item, [...path, key])
    return secrets ? [[key, secrets.value] as const] : []
  })
  return entries.length > 0 ? { value: Object.fromEntries(entries) } : undefined
}

function patchTo(text: string, path: string[], from: unknown, to: unknown): string {
  if (isRecord(from) && isRecord(to)) {
    const removed = Object.keys(from)
      .filter((key) => !Object.hasOwn(to, key))
      .reduce((current, key) => edit(current, [...path, key], undefined), text)
    return Object.entries(to).reduce((current, [key, value]) => patchTo(current, [...path, key], from[key], value), removed)
  }
  if (JSON.stringify(from) === JSON.stringify(to)) return text
  return edit(text, path, to)
}

function edit(text: string, path: string[], value: unknown) {
  return applyEdits(text, modify(text, path, value, FORMAT))
}

function isReference(value: unknown) {
  return typeof value === "string" && REFERENCE.test(value)
}
```

- [ ] **Step 5: Add the settings routes**

In `packages/opencode/src/server/routes/instance/httpapi/machine-sync.ts` add imports:

```ts
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { MachineSyncConfig } from "@/machine-sync/config-sync"
```

Inside `HttpRouter.use(…)`, after `const store = yield* MachineSyncStore.Service`, bind:

```ts
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service

    const modified = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => Option.getOrElse(Option.map(info.mtime, (date) => date.getTime()), () => 0)),
        Effect.orElseSucceed(() => 0),
      )
```

and add these routes after the `missing` route:

```ts
    yield* router.add("GET", MachineSyncPaths.settings, () =>
      Effect.gen(function* () {
        const file = Config.globalConfigFile()
        const text = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
        if (text === undefined) return json({ config: null, mtime: 0 })
        const parsed = yield* Effect.try(() => ConfigParse.jsonc(text, file)).pipe(Effect.option)
        if (Option.isNone(parsed)) return json({ config: null, mtime: 0 })
        return json({ config: MachineSyncConfig.sanitizeConfig(parsed.value), mtime: yield* modified(file) })
      }),
    )

    yield* router.add("POST", MachineSyncPaths.settingsApply, (request) =>
      Effect.gen(function* () {
        const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (!isRecord(body) || !isRecord(body.config) || typeof body.mtime !== "number")
          return json({ error: "bad request" }, 400)
        const peer = body.config
        const mtime = body.mtime
        const file = Config.globalConfigFile()
        // Newest edit wins by file mtime; a tie keeps the local file.
        if (mtime <= (yield* modified(file))) return json({ applied: false })
        const localText = (yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))) ?? "{}"
        return yield* Effect.try({
          try: () => {
            const next = MachineSyncConfig.applyPeerConfig({ localText, local: ConfigParse.jsonc(localText, file), peer })
            Config.validateText(next, file)
            return next
          },
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }).pipe(
          Effect.flatMap((next) =>
            Effect.gen(function* () {
              if (next !== localText) yield* fs.writeWithDirs(file, next)
              // Stamp the peer's mtime so the next cycle on either side sees a tie.
              yield* fs.utimes(file, new Date(mtime), new Date(mtime))
              yield* config.invalidate()
              return json({ applied: true })
            }),
          ),
          Effect.catch((error) => Effect.succeed(json({ error: String(error) }, 422))),
        )
      }),
    )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/machine-sync/config-sync.test.ts test/server/httpapi-machine-sync.test.ts test/config/config.test.ts`
Expected: PASS (new tests green; existing config tests unaffected).

- [ ] **Step 7: Typecheck**

Run: `cd packages/opencode && bun typecheck`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/opencode/src/machine-sync/config-sync.ts packages/opencode/src/config/config.ts packages/opencode/src/server/routes/instance/httpapi/machine-sync.ts packages/opencode/test/machine-sync/config-sync.test.ts packages/opencode/test/server/httpapi-machine-sync.test.ts
git commit -m "$(cat <<'EOF'
feat(opencode): sync the global config without secrets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Gateway sync routes, pairing token auth, phone-access gating

**Files:**
- Create: `packages/mobile-gateway/src/sync-gate.ts`
- Create: `packages/mobile-gateway/src/sync-routes.ts`
- Create: `packages/mobile-gateway/src/sync-pair.ts`
- Modify: `packages/mobile-gateway/src/gateway.ts` (imports lines 1-13; `createGateway` signature line 98 and the start of `handle` lines 105-107; `startGateway` lines 229-236)
- Modify: `packages/mobile-gateway/package.json` (`exports`)
- Test: `packages/mobile-gateway/test/sync-routes.test.ts`

**Interfaces:**
- Consumes: `GatewayOptions`, `envAuthHeader` (`config.ts`), `upstreamUrl` (`upstream.ts`), `streamThrough` (`proxy.ts`).
- Produces:
  - `sync-gate.ts`: `type SyncPeer = { name: string; url: string; token: string }`, `type SyncPrefs = { sections: Record<string, unknown>; updatedAt: number }`, `type PairingCode = { code: string; expiresAt: number }`, `PAIRING_CODE_TTL_MS = 600_000`, `MAX_PAIR_ATTEMPTS = 5`, `createSyncGate(input: { machineName: string; gatewayPort: number; phoneAccess: boolean; paused: boolean; peer: SyncPeer | undefined; prefs: SyncPrefs | undefined; now?: () => number; token?: () => string; onPaired?: (peer: SyncPeer) => void; onUnpaired?: () => void })` returning `{ phoneAccess(): boolean; paused(): boolean; peer(): SyncPeer | undefined; prefs(): SyncPrefs | undefined; pairingActive(): boolean; authorized(header: string | null): boolean; update(next: { phoneAccess?: boolean; paused?: boolean; peer?: SyncPeer | null; prefs?: SyncPrefs }): void; setPairingCode(code: PairingCode | undefined): void; pair(request: { code: string; name: string; remoteAddress: string | undefined }): { token: string; name: string } | "invalid" | "locked"; revoke(): void; countSent(): void; takeSent(): number }`; `type SyncGate = ReturnType<typeof createSyncGate>`.
  - `sync-routes.ts`: `handleSync(input: { request: Request; remoteAddress: string | undefined; options: GatewayOptions; gate: SyncGate | undefined }): Promise<Response>`.
  - `sync-pair.ts`: `SYNC_PORT = 4097`, `peerBaseUrl(host: string): string`, `type PairResult = { ok: true; peer: SyncPeer } | { ok: false; reason: "unreachable" | "invalid-code" | "failed" }`, `pairWithPeer(input: { host: string; code: string; name: string; fetchImpl?: typeof fetch }): Promise<PairResult>`, `unpairPeer(input: { peer: SyncPeer; fetchImpl?: typeof fetch }): Promise<void>`.
  - `gateway.ts`: `createGateway(input: { options: GatewayOptions; sync?: SyncGate })`, `startGateway(input: { options: GatewayOptions; port?: number; sync?: SyncGate })`.
  - Gateway HTTP: `POST /flynncode-sync/pair` `{ code, name }` → 200 `{ token, name }` | 403 `{ error: "invalid-code" }` | 429 `{ error: "locked" }`; with `Bearer <token>`: `POST /flynncode-sync/unpair`, `GET /flynncode-sync/prefs` → `{ prefs: SyncPrefs | null }`, `GET /flynncode-sync/manifest|settings|session/<ses…>` forwarded to the server with server Basic auth; anything else under `/flynncode-sync/` → 404; missing/wrong token → 401; paused → 503.
  - Package exports: `"./sync-gate": "./src/sync-gate.ts"`, `"./sync-pair": "./src/sync-pair.ts"`, `"./lan-ips": "./src/lan-ips.ts"`.

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/sync-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { GatewayOptions } from "../src/config.ts"
import { createGateway } from "../src/gateway.ts"
import { createSyncGate, type SyncPeer } from "../src/sync-gate.ts"
import { pairWithPeer, peerBaseUrl, unpairPeer } from "../src/sync-pair.ts"

const basic = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`

let upstream: ReturnType<typeof Bun.serve>
const upstreamPaths: string[] = []
const options: GatewayOptions = {
  host: "127.0.0.1",
  port: 0,
  upstream: "",
  username: "opencode",
  password: "phone",
  upstreamPassword: "server",
  relayToken: "",
}

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      upstreamPaths.push(url.pathname)
      if (request.headers.get("authorization") !== basic("opencode", "server")) return new Response("no", { status: 401 })
      if (url.pathname === "/api/session") return Response.json({ data: [] })
      return Response.json({ path: url.pathname })
    },
  })
  options.upstream = `http://127.0.0.1:${upstream.port}`
})

afterAll(() => upstream.stop(true))

const peer: SyncPeer = { name: "starship", url: "http://192.168.1.20:4097", token: "a".repeat(64) }

function gate(input: { phoneAccess?: boolean; peer?: SyncPeer; paused?: boolean } = {}) {
  const events: string[] = []
  const value = createSyncGate({
    machineName: "challenger",
    gatewayPort: 4097,
    phoneAccess: input.phoneAccess ?? false,
    paused: input.paused ?? false,
    peer: input.peer,
    prefs: { sections: { appearance: { fontSize: 15 } }, updatedAt: 7 },
    token: () => "b".repeat(64),
    onPaired: (paired) => events.push(`paired:${paired.name}:${paired.url}`),
    onUnpaired: () => events.push("unpaired"),
  })
  return { value, events }
}

const pairRequest = (code: string) =>
  new Request("http://gateway/flynncode-sync/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "starship" }),
  })

describe("pairing", () => {
  test("a valid code mints a token and records the caller as the peer", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    const handle = createGateway({ options, sync: sync.value })
    const response = await handle(pairRequest("482913"), "::ffff:192.168.1.20")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ token: "b".repeat(64), name: "challenger" })
    expect(sync.value.peer()).toEqual({ name: "starship", url: "http://192.168.1.20:4097", token: "b".repeat(64) })
    expect(sync.events).toEqual(["paired:starship:http://192.168.1.20:4097"])
    expect(sync.value.pairingActive()).toBe(false)
  })

  test("wrong codes are rejected and five failures burn the code", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "482913", expiresAt: Date.now() + 60_000 })
    const handle = createGateway({ options, sync: sync.value })
    const statuses = []
    for (const attempt of [1, 2, 3, 4, 5]) statuses.push((await handle(pairRequest(`00000${attempt}`), "192.168.1.20")).status)
    expect(statuses).toEqual([403, 403, 403, 403, 429])
    expect((await handle(pairRequest("482913"), "192.168.1.20")).status).toBe(403)
  })

  test("an expired code is rejected", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "482913", expiresAt: Date.now() - 1 })
    const handle = createGateway({ options, sync: sync.value })
    expect((await handle(pairRequest("482913"), "192.168.1.20")).status).toBe(403)
  })
})

describe("token-gated sync routes", () => {
  test("require the pairing token; the phone password does not open them", async () => {
    const handle = createGateway({ options, sync: gate({ peer, phoneAccess: true }).value })
    const manifest = "http://gateway/flynncode-sync/manifest"
    expect((await handle(new Request(manifest), "192.168.1.20")).status).toBe(401)
    expect(
      (await handle(new Request(manifest, { headers: { authorization: basic("opencode", "phone") } }), "192.168.1.20")).status,
    ).toBe(401)
    const ok = await handle(new Request(manifest, { headers: { authorization: `Bearer ${peer.token}` } }), "192.168.1.20")
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ path: "/flynncode-sync/manifest" })
  })

  test("forward only the read-only allowlist and count bundles sent", async () => {
    const sync = gate({ peer })
    const handle = createGateway({ options, sync: sync.value })
    const auth = { authorization: `Bearer ${peer.token}` }
    expect((await handle(new Request("http://gateway/flynncode-sync/session/ses_1", { headers: auth }), undefined)).status).toBe(200)
    expect((await handle(new Request("http://gateway/flynncode-sync/settings", { headers: auth }), undefined)).status).toBe(200)
    expect((await handle(new Request("http://gateway/flynncode-sync/missing", { headers: auth }), undefined)).status).toBe(404)
    expect(
      (await handle(new Request("http://gateway/flynncode-sync/apply", { method: "POST", headers: auth, body: "{}" }), undefined)).status,
    ).toBe(405)
    expect(sync.value.takeSent()).toBe(1)
    expect(sync.value.takeSent()).toBe(0)
  })

  test("serve prefs from the gate and stop serving while paused", async () => {
    const auth = { authorization: `Bearer ${peer.token}` }
    const live = createGateway({ options, sync: gate({ peer }).value })
    const prefs = await live(new Request("http://gateway/flynncode-sync/prefs", { headers: auth }), undefined)
    expect(await prefs.json()).toEqual({ prefs: { sections: { appearance: { fontSize: 15 } }, updatedAt: 7 } })
    const paused = createGateway({ options, sync: gate({ peer, paused: true }).value })
    expect((await paused(new Request("http://gateway/flynncode-sync/manifest", { headers: auth }), undefined)).status).toBe(503)
  })

  test("unpair revokes the token", async () => {
    const sync = gate({ peer })
    const handle = createGateway({ options, sync: sync.value })
    const response = await handle(
      new Request("http://gateway/flynncode-sync/unpair", { method: "POST", headers: { authorization: `Bearer ${peer.token}` } }),
      undefined,
    )
    expect(response.status).toBe(200)
    expect(sync.value.peer()).toBeUndefined()
    expect(sync.events).toEqual(["unpaired"])
  })

  test("a gateway without a sync gate serves no sync routes", async () => {
    const handle = createGateway({ options })
    expect((await handle(new Request("http://gateway/flynncode-sync/manifest"), undefined)).status).toBe(404)
  })
})

describe("phone access gating", () => {
  test("with phone access off every phone route answers 404 and sync still works", async () => {
    const handle = createGateway({ options, sync: gate({ peer, phoneAccess: false }).value })
    const phone = { authorization: basic("opencode", "phone") }
    expect((await handle(new Request("http://gateway/flynncode-mobile-status"), "127.0.0.1")).status).toBe(404)
    expect((await handle(new Request("http://gateway/m", { headers: phone }), "192.168.1.20")).status).toBe(404)
    expect((await handle(new Request("http://gateway/flynncode-mobile-inbox", { headers: phone }), "192.168.1.20")).status).toBe(404)
    expect((await handle(new Request("http://gateway/flynncode-mobile-relay/inbox", { headers: phone }), "192.168.1.20")).status).toBe(404)
    expect((await handle(new Request("http://gateway/api/session", { headers: phone }), "192.168.1.20")).status).toBe(404)
    const sync = await handle(
      new Request("http://gateway/flynncode-sync/manifest", { headers: { authorization: `Bearer ${peer.token}` } }),
      "192.168.1.20",
    )
    expect(sync.status).toBe(200)
  })

  test("turning phone access on takes effect on the next request", async () => {
    const sync = gate({ phoneAccess: false })
    const handle = createGateway({ options, sync: sync.value })
    expect((await handle(new Request("http://gateway/flynncode-mobile-status"), "127.0.0.1")).status).toBe(404)
    sync.value.update({ phoneAccess: true })
    expect((await handle(new Request("http://gateway/flynncode-mobile-status"), "127.0.0.1")).status).toBe(200)
  })
})

describe("pairing client", () => {
  test("builds peer URLs from a host, host:port or URL", () => {
    expect(peerBaseUrl("starship.local")).toBe("http://starship.local:4097")
    expect(peerBaseUrl("192.168.1.20:5000")).toBe("http://192.168.1.20:5000")
    expect(peerBaseUrl("http://192.168.1.20:4097/")).toBe("http://192.168.1.20:4097")
  })

  test("pairs against a real gateway and unpairs again", async () => {
    const sync = gate()
    sync.value.setPairingCode({ code: "135790", expiresAt: Date.now() + 60_000 })
    const handle = createGateway({ options, sync: sync.value })
    const server = Bun.serve({ port: 0, fetch: (request, srv) => handle(request, srv.requestIP(request)?.address) })
    const host = `127.0.0.1:${server.port}`
    expect(await pairWithPeer({ host, code: "000000", name: "starship" })).toEqual({ ok: false, reason: "invalid-code" })
    const result = await pairWithPeer({ host, code: "135790", name: "starship" })
    expect(result).toEqual({ ok: true, peer: { name: "challenger", url: `http://${host}`, token: "b".repeat(64) } })
    if (result.ok) await unpairPeer({ peer: result.peer })
    expect(sync.value.peer()).toBeUndefined()
    server.stop(true)
    expect(await pairWithPeer({ host: "127.0.0.1:9", code: "135790", name: "starship" })).toEqual({ ok: false, reason: "unreachable" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile-gateway && bun test test/sync-routes.test.ts`
Expected: FAIL — `Cannot find module '../src/sync-gate.ts'`.

- [ ] **Step 3: Implement the sync gate**

Create `packages/mobile-gateway/src/sync-gate.ts`:

```ts
import { randomBytes, timingSafeEqual } from "node:crypto"

export type SyncPeer = { name: string; url: string; token: string }
export type SyncPrefs = { sections: Record<string, unknown>; updatedAt: number }
export type PairingCode = { code: string; expiresAt: number }

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000
export const MAX_PAIR_ATTEMPTS = 5
const MAX_NAME_LENGTH = 64

export type SyncGate = ReturnType<typeof createSyncGate>

// Live sync state shared by the gateway routes and the sync worker. The
// desktop sidecar owns one gate and updates it from main-process messages, so
// phone access, pairing and pause apply without restarting anything.
export function createSyncGate(input: {
  machineName: string
  gatewayPort: number
  phoneAccess: boolean
  paused: boolean
  peer: SyncPeer | undefined
  prefs: SyncPrefs | undefined
  now?: () => number
  token?: () => string
  onPaired?: (peer: SyncPeer) => void
  onUnpaired?: () => void
}) {
  const now = input.now ?? Date.now
  const makeToken = input.token ?? (() => randomBytes(32).toString("hex"))
  const state = {
    phoneAccess: input.phoneAccess,
    paused: input.paused,
    peer: input.peer,
    prefs: input.prefs,
    pairing: undefined as PairingCode | undefined,
    attempts: 0,
    sent: 0,
  }

  return {
    phoneAccess: () => state.phoneAccess,
    paused: () => state.paused,
    peer: () => state.peer,
    prefs: () => state.prefs,
    pairingActive: () => state.pairing !== undefined && state.pairing.expiresAt > now(),
    authorized: (header: string | null) =>
      state.peer !== undefined && header !== null && safeEqual(header, `Bearer ${state.peer.token}`),
    update(next: { phoneAccess?: boolean; paused?: boolean; peer?: SyncPeer | null; prefs?: SyncPrefs }) {
      state.phoneAccess = next.phoneAccess ?? state.phoneAccess
      state.paused = next.paused ?? state.paused
      state.peer = next.peer === null ? undefined : (next.peer ?? state.peer)
      state.prefs = next.prefs ?? state.prefs
    },
    setPairingCode(code: PairingCode | undefined) {
      state.pairing = code
      state.attempts = 0
    },
    pair(request: { code: string; name: string; remoteAddress: string | undefined }) {
      const pairing = state.pairing
      if (!pairing || pairing.expiresAt <= now()) return "invalid" as const
      if (!safeEqual(request.code.trim(), pairing.code)) {
        state.attempts += 1
        if (state.attempts < MAX_PAIR_ATTEMPTS) return "invalid" as const
        // A six-digit code must not survive guessing over the LAN.
        state.pairing = undefined
        return "locked" as const
      }
      const peer = {
        name: request.name.trim().slice(0, MAX_NAME_LENGTH) || "peer",
        url: peerUrl(request.remoteAddress, input.gatewayPort),
        token: makeToken(),
      }
      state.pairing = undefined
      state.attempts = 0
      state.peer = peer
      input.onPaired?.(peer)
      return { token: peer.token, name: input.machineName }
    },
    revoke() {
      state.peer = undefined
      input.onUnpaired?.()
    },
    countSent() {
      state.sent += 1
    },
    takeSent() {
      const sent = state.sent
      state.sent = 0
      return sent
    },
  }
}

// The paired machine runs its gateway on the same port, so its URL is the
// caller's address plus our own gateway port.
function peerUrl(remoteAddress: string | undefined, port: number) {
  const host = (remoteAddress ?? "127.0.0.1").replace(/^::ffff:/i, "")
  return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`
}

function safeEqual(got: string, want: string) {
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
```

- [ ] **Step 4: Implement the gateway sync routes**

Create `packages/mobile-gateway/src/sync-routes.ts`:

```ts
import { envAuthHeader, type GatewayOptions } from "./config.ts"
import { streamThrough } from "./proxy.ts"
import type { SyncGate } from "./sync-gate.ts"
import { upstreamUrl } from "./upstream.ts"

// Only these read-only routes reach the local server for a paired peer.
// apply/delete/archive/missing stay loopback-only for the local sync worker.
const FORWARDED = /^\/flynncode-sync\/(manifest|settings|session\/ses[A-Za-z0-9_-]+)$/
const PAIR_MAX_BODY_BYTES = 4096
const UPSTREAM_TIMEOUT_MS = 60_000

export async function handleSync(input: {
  request: Request
  remoteAddress: string | undefined
  options: GatewayOptions
  gate: SyncGate | undefined
}): Promise<Response> {
  const gate = input.gate
  if (!gate) return json({ error: "not found" }, 404)
  const pathname = new URL(input.request.url, "http://localhost").pathname
  if (pathname === "/flynncode-sync/pair") return pair(input.request, input.remoteAddress, gate)
  // The pairing token is the only credential here; the phone password never
  // opens sync routes.
  if (!gate.authorized(input.request.headers.get("authorization"))) return json({ error: "unauthorized" }, 401)
  if (pathname === "/flynncode-sync/unpair") {
    if (input.request.method !== "POST") return json({ error: "method not allowed" }, 405)
    gate.revoke()
    return json({ ok: true }, 200)
  }
  if (input.request.method !== "GET") return json({ error: "method not allowed" }, 405)
  if (gate.paused()) return json({ error: "paused" }, 503)
  if (pathname === "/flynncode-sync/prefs") return json({ prefs: gate.prefs() ?? null }, 200)
  if (!FORWARDED.test(pathname)) return json({ error: "not found" }, 404)
  const upstream = await fetch(upstreamUrl(input.options.upstream, input.request.url), {
    headers: { authorization: envAuthHeader(input.options) },
    redirect: "error",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!upstream) return json({ error: "upstream unavailable" }, 502)
  if (upstream.ok && pathname.startsWith("/flynncode-sync/session/")) gate.countSent()
  return streamThrough(upstream)
}

async function pair(request: Request, remoteAddress: string | undefined, gate: SyncGate) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > PAIR_MAX_BODY_BYTES) return json({ error: "payload too large" }, 413)
  const body: unknown = await request.json().catch(() => undefined)
  if (!isRecord(body) || typeof body.code !== "string" || typeof body.name !== "string")
    return json({ error: "bad request" }, 400)
  const result = gate.pair({ code: body.code, name: body.name, remoteAddress })
  if (result === "invalid") return json({ error: "invalid-code" }, 403)
  if (result === "locked") return json({ error: "locked" }, 429)
  return json(result, 200)
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
```

- [ ] **Step 5: Implement the pairing client**

Create `packages/mobile-gateway/src/sync-pair.ts`:

```ts
import type { SyncPeer } from "./sync-gate.ts"

export const SYNC_PORT = 4097
const PAIR_TIMEOUT_MS = 5000
const UNPAIR_TIMEOUT_MS = 3000

export type PairResult = { ok: true; peer: SyncPeer } | { ok: false; reason: "unreachable" | "invalid-code" | "failed" }

// Accepts what a user types: `starship.local`, `192.168.1.20`, `host:port`
// or a full http(s) URL.
export function peerBaseUrl(host: string) {
  const trimmed = host.trim().replace(/\/+$/, "")
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[^:]+:\d+$/.test(trimmed)) return `http://${trimmed}`
  if (trimmed.includes(":")) return `http://[${trimmed}]:${SYNC_PORT}`
  return `http://${trimmed}:${SYNC_PORT}`
}

export async function pairWithPeer(input: {
  host: string
  code: string
  name: string
  fetchImpl?: typeof fetch
}): Promise<PairResult> {
  const url = peerBaseUrl(input.host)
  const response = await (input.fetchImpl ?? fetch)(`${url}/flynncode-sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: input.code.trim(), name: input.name }),
    redirect: "error",
    signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response) return { ok: false, reason: "unreachable" }
  if (response.status === 403 || response.status === 429) return { ok: false, reason: "invalid-code" }
  if (!response.ok) return { ok: false, reason: "failed" }
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body) || typeof body.token !== "string" || typeof body.name !== "string")
    return { ok: false, reason: "failed" }
  return { ok: true, peer: { name: body.name, url, token: body.token } }
}

// Best effort: an unreachable peer keeps its record until it notices the 401.
export async function unpairPeer(input: { peer: SyncPeer; fetchImpl?: typeof fetch }) {
  await (input.fetchImpl ?? fetch)(`${input.peer.url}/flynncode-sync/unpair`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.peer.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(UNPAIR_TIMEOUT_MS),
  }).catch(() => undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
```

- [ ] **Step 6: Route sync and gate phone access in the gateway**

In `packages/mobile-gateway/src/gateway.ts`:

1. Add imports after line 13:

```ts
import type { SyncGate } from "./sync-gate.ts"
import { handleSync } from "./sync-routes.ts"
```

2. Replace the `createGateway` signature and the first line of `handle` (lines 98-106):

```ts
export function createGateway(input: { options: GatewayOptions; sync?: SyncGate }) {
  const options = input.options
  const authorization = envAuthHeader(options)
  const sessions = createSessionStore()

  // remoteAddress is the socket peer address. The Host header is
  // client-controlled, so it must never decide whether a caller is local.
  return async function handle(request: Request, remoteAddress?: string): Promise<Response> {
    const parsed = new URL(request.url, "http://localhost")
    if (parsed.pathname.startsWith("/flynncode-sync/")) {
      return handleSync({ request, remoteAddress, options, gate: input.sync })
    }
    // Phone access is opt-in on the desktop. With it off, every phone route
    // (launcher, proxy, inbox, relay, status) answers 404 and the gateway only
    // serves machine sync. Gateways without a sync gate (plugin, CLI) keep
    // phone access on.
    if (input.sync && !input.sync.phoneAccess()) return new Response("Not found", { status: 404 })
```

(the existing `if (parsed.pathname === "/flynncode-mobile-status") {` block follows unchanged).

3. Replace the `startGateway` signature and the `createGateway` call inside it:

```ts
export async function startGateway(input: { options: GatewayOptions; port?: number; sync?: SyncGate }): Promise<Gateway> {
```

and

```ts
  const handle = createGateway({ options: input.options, sync: input.sync })
```

- [ ] **Step 7: Export the new modules**

In `packages/mobile-gateway/package.json` set `exports` to:

```json
  "exports": {
    ".": "./src/config.ts",
    "./server": "./src/index.ts",
    "./gateway": "./src/gateway.ts",
    "./sync-gate": "./src/sync-gate.ts",
    "./sync-pair": "./src/sync-pair.ts",
    "./lan-ips": "./src/lan-ips.ts"
  },
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd packages/mobile-gateway && bun test --timeout 30000`
Expected: PASS — new `sync-routes.test.ts` plus all existing gateway, relay, inbox and launcher tests (they create gateways without a sync gate, so phone routes behave as before).

- [ ] **Step 9: Typecheck**

Run: `cd packages/mobile-gateway && bun typecheck` and `cd packages/desktop && bun typecheck`
Expected: both exit 0 (desktop still calls `startGateway({ options })`).

- [ ] **Step 10: Commit**

```bash
git add packages/mobile-gateway/src/sync-gate.ts packages/mobile-gateway/src/sync-routes.ts packages/mobile-gateway/src/sync-pair.ts packages/mobile-gateway/src/gateway.ts packages/mobile-gateway/package.json packages/mobile-gateway/test/sync-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile-gateway): pair sync peers and gate phone access

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Sync worker loop with backoff, batches and status

**Files:**
- Create: `packages/mobile-gateway/src/sync-worker.ts`
- Modify: `packages/mobile-gateway/package.json` (add `"./sync": "./src/sync-worker.ts"` to `exports`)
- Test: `packages/mobile-gateway/test/sync-worker.test.ts`

**Interfaces:**
- Consumes: `decide`, `isManifest`, `Manifest` (Task 3); `SyncPeer`, `SyncPrefs` (Task 6); local server routes from Tasks 4-5 (`/flynncode-sync/manifest`, `/apply`, `/delete/:id`, `/archive/:id`, `/missing`, `/settings/apply`); peer gateway routes from Task 6 (`/flynncode-sync/manifest`, `/session/:id`, `/settings`, `/prefs`).
- Produces:
  - `POLL_MS = 60_000`, `BACKOFF_MS = 300_000`, `BACKOFF_AFTER_FAILURES = 5`, `BATCH_SIZE = 20`, `BATCH_DELAY_MS = 1_000`
  - `type SyncPhase = "idle" | "offline" | "mismatch" | "unauthorized" | "paused" | "unpaired"`
  - `type SyncStatus = { phase: SyncPhase; online: boolean; lastSuccess: number | null; received: number; sent: number; missingDirectories: string[]; backlog: { done: number; total: number } | null; failures: Array<{ id: string; error: string }>; skipped: Array<{ id: string; reason: "local-busy" | "peer-busy" }>; lastError: string | null; consecutiveFailures: number }`
  - `initialStatus(): SyncStatus`, `nextDelay(status: SyncStatus, timing?: { pollMs: number; backoffMs: number; batchDelayMs: number }): number`
  - `createSyncWorker(options: { local: { url: string; authorization: string }; peer: () => SyncPeer | undefined; paused: () => boolean; prefs: { get(): SyncPrefs | undefined; apply(prefs: SyncPrefs): void }; takeSent: () => number; onStatus: (status: SyncStatus) => void; fetchImpl?: typeof fetch; now?: () => number; pollMs?: number; backoffMs?: number; batchDelayMs?: number })` → `{ cycle(): Promise<SyncStatus>; start(): void; stop(): void; syncNow(): Promise<SyncStatus>; status(): SyncStatus }`; `type SyncWorker = ReturnType<typeof createSyncWorker>`.

- [ ] **Step 1: Write the failing test**

Create `packages/mobile-gateway/test/sync-worker.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import type { Manifest, ManifestSession } from "../src/sync-decide.ts"
import type { SyncPrefs } from "../src/sync-gate.ts"
import { createSyncWorker, initialStatus, nextDelay } from "../src/sync-worker.ts"

type Fake = {
  manifest: Manifest
  bundles: Map<string, { session: { id: string; time_updated: number } }>
  applied: string[]
  settings: { config: Record<string, unknown> | null; mtime: number }
  settingsApplied: unknown[]
  prefs: SyncPrefs | null
  down: boolean
}

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  while (servers.length) servers.pop()?.stop(true)
})

const session = (id: string, timeUpdated: number): ManifestSession => ({
  id,
  parentID: null,
  timeUpdated,
  timeArchived: null,
  busy: false,
})

function fake(sessions: ManifestSession[], schema = "s1"): Fake {
  return {
    manifest: { schema, app: "1.0.0", sessions, tombstones: [] },
    bundles: new Map(sessions.map((item) => [item.id, { session: { id: item.id, time_updated: item.timeUpdated } }])),
    applied: [],
    settings: { config: null, mtime: 0 },
    settingsApplied: [],
    prefs: null,
    down: false,
  }
}

// One fake plays either the local server (Basic auth) or the peer gateway
// (Bearer token); the worker only sees HTTP.
function serve(state: Fake, authorization: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (state.down) return new Response("down", { status: 503 })
      if (request.headers.get("authorization") !== authorization) return new Response("unauthorized", { status: 401 })
      const path = new URL(request.url).pathname
      if (path === "/flynncode-sync/manifest") return Response.json(state.manifest)
      if (path === "/flynncode-sync/missing") return Response.json({ directories: ["/gone"] })
      if (path === "/flynncode-sync/settings") return Response.json(state.settings)
      if (path === "/flynncode-sync/prefs") return Response.json({ prefs: state.prefs })
      if (path === "/flynncode-sync/settings/apply") {
        state.settingsApplied.push(await request.json())
        return Response.json({ applied: true })
      }
      if (path === "/flynncode-sync/apply") {
        const body = (await request.json()) as { session: { id: string; time_updated: number } }
        state.applied.push(body.session.id)
        state.manifest.sessions.push(session(body.session.id, body.session.time_updated))
        return Response.json({ ok: true })
      }
      const bundle = /^\/flynncode-sync\/session\/(.+)$/.exec(path)
      if (bundle?.[1]) return Response.json(state.bundles.get(bundle[1]))
      return new Response("not found", { status: 404 })
    },
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

function worker(input: { local: Fake; peer: Fake; token?: string; prefs?: { current?: SyncPrefs; applied: SyncPrefs[] } }) {
  const localUrl = serve(input.local, "Basic local")
  const peerUrl = serve(input.peer, "Bearer token-1")
  const prefs = input.prefs ?? { applied: [] }
  return createSyncWorker({
    local: { url: localUrl, authorization: "Basic local" },
    peer: () => ({ name: "starship", url: peerUrl, token: input.token ?? "token-1" }),
    paused: () => false,
    prefs: { get: () => prefs.current, apply: (next) => prefs.applied.push(next) },
    takeSent: () => 3,
    onStatus: () => undefined,
  })
}

describe("sync worker", () => {
  test("pulls newer chats and reports the cycle", async () => {
    const local = fake([session("ses_a", 10)])
    const peer = fake([session("ses_a", 20), session("ses_b", 5)])
    const status = await worker({ local, peer }).cycle()
    expect(local.applied).toEqual(["ses_a", "ses_b"])
    expect(status).toMatchObject({
      phase: "idle",
      online: true,
      received: 2,
      sent: 3,
      missingDirectories: ["/gone"],
      backlog: null,
      failures: [],
      consecutiveFailures: 0,
    })
    expect(status.lastSuccess).toBeNumber()
  })

  test("pauses on a schema or app version mismatch without applying", async () => {
    const local = fake([], "s1")
    const peer = fake([session("ses_a", 20)], "s2")
    const status = await worker({ local, peer }).cycle()
    expect(status.phase).toBe("mismatch")
    expect(local.applied).toEqual([])
  })

  test("asks to pair again on 401", async () => {
    const status = await worker({ local: fake([]), peer: fake([]), token: "stale" }).cycle()
    expect(status.phase).toBe("unauthorized")
  })

  test("counts consecutive offline cycles and backs off after five", async () => {
    const peer = fake([])
    peer.down = true
    const sync = worker({ local: fake([]), peer })
    const results = []
    for (const _ of [1, 2, 3, 4, 5]) results.push(await sync.cycle())
    expect(results.map((status) => status.consecutiveFailures)).toEqual([1, 2, 3, 4, 5])
    expect(results.every((status) => status.phase === "offline" && !status.online)).toBe(true)
    expect(nextDelay(results[3]!)).toBe(60_000)
    expect(nextDelay(results[4]!)).toBe(300_000)
    peer.down = false
    const recovered = await sync.cycle()
    expect(recovered.consecutiveFailures).toBe(0)
    expect(nextDelay(recovered)).toBe(60_000)
  })

  test("pulls at most 20 bundles per cycle and reports first-sync progress", async () => {
    const local = fake([])
    const peer = fake(Array.from({ length: 25 }, (_, index) => session(`ses_${String(index).padStart(2, "0")}`, 10)))
    const sync = worker({ local, peer })
    const first = await sync.cycle()
    expect(local.applied.length).toBe(20)
    expect(first.backlog).toEqual({ done: 20, total: 25 })
    expect(nextDelay(first)).toBe(1_000)
    const second = await sync.cycle()
    expect(local.applied.length).toBe(25)
    expect(second.backlog).toBeNull()
  })

  test("forwards peer settings to the local server and applies newer peer prefs", async () => {
    const local = fake([])
    const peer = fake([])
    peer.settings = { config: { model: "a/b" }, mtime: 9 }
    peer.prefs = { sections: { appearance: { fontSize: 16 } }, updatedAt: 20 }
    const prefs = { current: { sections: {}, updatedAt: 10 }, applied: [] as SyncPrefs[] }
    await worker({ local, peer, prefs }).cycle()
    expect(local.settingsApplied).toEqual([{ config: { model: "a/b" }, mtime: 9 }])
    expect(prefs.applied).toEqual([peer.prefs])
  })

  test("reports unpaired when there is no peer", async () => {
    const sync = createSyncWorker({
      local: { url: "http://127.0.0.1:9", authorization: "Basic local" },
      peer: () => undefined,
      paused: () => false,
      prefs: { get: () => undefined, apply: () => undefined },
      takeSent: () => 0,
      onStatus: () => undefined,
    })
    expect((await sync.cycle()).phase).toBe("unpaired")
    expect(initialStatus().phase).toBe("unpaired")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile-gateway && bun test test/sync-worker.test.ts`
Expected: FAIL — `Cannot find module '../src/sync-worker.ts'`.

- [ ] **Step 3: Implement the worker**

Create `packages/mobile-gateway/src/sync-worker.ts`:

```ts
import { decide, isManifest, type SyncAction } from "./sync-decide.ts"
import type { SyncPeer, SyncPrefs } from "./sync-gate.ts"

export const POLL_MS = 60_000
export const BACKOFF_MS = 5 * 60_000
export const BACKOFF_AFTER_FAILURES = 5
export const BATCH_SIZE = 20
export const BATCH_DELAY_MS = 1_000
const REQUEST_TIMEOUT_MS = 60_000

export type SyncPhase = "idle" | "offline" | "mismatch" | "unauthorized" | "paused" | "unpaired"

export type SyncStatus = {
  phase: SyncPhase
  online: boolean
  lastSuccess: number | null
  received: number
  sent: number
  missingDirectories: string[]
  backlog: { done: number; total: number } | null
  failures: Array<{ id: string; error: string }>
  skipped: Array<{ id: string; reason: "local-busy" | "peer-busy" }>
  lastError: string | null
  consecutiveFailures: number
}

export type SyncWorker = ReturnType<typeof createSyncWorker>

type Fetched<T> = { kind: "ok"; value: T } | { kind: "unauthorized" } | { kind: "unreachable" } | { kind: "invalid" }

export function initialStatus(): SyncStatus {
  return {
    phase: "unpaired",
    online: false,
    lastSuccess: null,
    received: 0,
    sent: 0,
    missingDirectories: [],
    backlog: null,
    failures: [],
    skipped: [],
    lastError: null,
    consecutiveFailures: 0,
  }
}

export function nextDelay(
  status: SyncStatus,
  timing = { pollMs: POLL_MS, backoffMs: BACKOFF_MS, batchDelayMs: BATCH_DELAY_MS },
) {
  if (status.backlog) return timing.batchDelayMs
  if (status.consecutiveFailures >= BACKOFF_AFTER_FAILURES) return timing.backoffMs
  return timing.pollMs
}

// Pulls from the paired machine through its gateway and writes only through
// this machine's own server, so each side only ever changes its own database.
export function createSyncWorker(options: {
  local: { url: string; authorization: string }
  peer: () => SyncPeer | undefined
  paused: () => boolean
  prefs: { get(): SyncPrefs | undefined; apply(prefs: SyncPrefs): void }
  takeSent: () => number
  onStatus: (status: SyncStatus) => void
  fetchImpl?: typeof fetch
  now?: () => number
  pollMs?: number
  backoffMs?: number
  batchDelayMs?: number
}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const timing = {
    pollMs: options.pollMs ?? POLL_MS,
    backoffMs: options.backoffMs ?? BACKOFF_MS,
    batchDelayMs: options.batchDelayMs ?? BATCH_DELAY_MS,
  }
  const state = {
    status: initialStatus(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    running: undefined as Promise<SyncStatus> | undefined,
    stopped: true,
  }

  const send = (url: string, authorization: string, body?: unknown) =>
    fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? { authorization } : { authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => undefined)
  const local = (path: string, body?: unknown) => send(`${options.local.url}${path}`, options.local.authorization, body)
  const remote = (peer: SyncPeer, path: string) => send(`${peer.url}${path}`, `Bearer ${peer.token}`)

  async function runCycle(): Promise<SyncStatus> {
    const previous = state.status
    const peer = options.peer()
    if (!peer) return initialStatus()
    if (options.paused()) return { ...previous, phase: "paused" }
    const localManifest = await read(local("/flynncode-sync/manifest"), isManifest)
    if (localManifest.kind !== "ok") return { ...previous, phase: "offline", lastError: "local server unavailable" }
    const peerManifest = await read(remote(peer, "/flynncode-sync/manifest"), isManifest)
    if (peerManifest.kind === "unauthorized") return { ...previous, phase: "unauthorized", online: true, consecutiveFailures: 0 }
    if (peerManifest.kind !== "ok")
      return { ...previous, phase: "offline", online: false, consecutiveFailures: previous.consecutiveFailures + 1 }
    if (localManifest.value.schema !== peerManifest.value.schema || localManifest.value.app !== peerManifest.value.app)
      return { ...previous, phase: "mismatch", online: true, consecutiveFailures: 0 }

    const actions = decide({ local: localManifest.value, peer: peerManifest.value })
    const pulls = actions.filter((action): action is Extract<SyncAction, { type: "pull" }> => action.type === "pull")
    const batch = pulls.slice(0, BATCH_SIZE)
    // Requests run one at a time so a big first sync never floods either side.
    const results: Array<{ id: string; outcome: "applied" | "busy" | string }> = []
    for (const action of actions) {
      if (action.type === "delete")
        results.push({ id: action.id, outcome: await write(`/flynncode-sync/delete/${action.id}`, { timeDeleted: action.timeDeleted }) })
      if (action.type === "archive")
        results.push({ id: action.id, outcome: await write(`/flynncode-sync/archive/${action.id}`, { timeArchived: action.timeArchived }) })
    }
    const pulled: Array<{ id: string; outcome: "applied" | "busy" | string }> = []
    for (const action of batch) pulled.push({ id: action.id, outcome: await pull(peer, action.id) })

    const received = pulled.filter((result) => result.outcome === "applied").length
    const failures = [...results, ...pulled]
      .filter((result) => result.outcome !== "applied" && result.outcome !== "busy")
      .map((result) => ({ id: result.id, error: result.outcome }))
    const skipped = [
      ...actions.flatMap((action) => (action.type === "skip" ? [{ id: action.id, reason: action.reason }] : [])),
      ...[...results, ...pulled]
        .filter((result) => result.outcome === "busy")
        .map((result) => ({ id: result.id, reason: "local-busy" as const })),
    ]
    const settingsError = await syncSettings(peer)
    await syncPrefs(peer)
    const missing = await read(local("/flynncode-sync/missing"), isMissing)
    return {
      phase: "idle",
      online: true,
      lastSuccess: now(),
      received,
      sent: options.takeSent(),
      missingDirectories: missing.kind === "ok" ? missing.value.directories : previous.missingDirectories,
      backlog:
        pulls.length > batch.length
          ? { total: previous.backlog?.total ?? pulls.length, done: (previous.backlog?.done ?? 0) + received }
          : null,
      failures,
      skipped,
      lastError: settingsError,
      consecutiveFailures: 0,
    }
  }

  async function write(path: string, body: unknown): Promise<"applied" | "busy" | string> {
    const response = await local(path, body)
    if (!response) return "local server unavailable"
    if (response.status === 409) return "busy"
    if (response.ok) return "applied"
    return `${response.status} ${await response.text().catch(() => "")}`.trim()
  }

  async function pull(peer: SyncPeer, id: string) {
    const bundle = await read(remote(peer, `/flynncode-sync/session/${encodeURIComponent(id)}`), isRecord)
    if (bundle.kind !== "ok") return `fetch failed (${bundle.kind})`
    return write("/flynncode-sync/apply", bundle.value)
  }

  async function syncSettings(peer: SyncPeer): Promise<string | null> {
    const settings = await read(remote(peer, "/flynncode-sync/settings"), isSettings)
    if (settings.kind !== "ok" || settings.value.config === null) return null
    const outcome = await write("/flynncode-sync/settings/apply", settings.value)
    return outcome === "applied" ? null : `settings: ${outcome}`
  }

  async function syncPrefs(peer: SyncPeer) {
    const result = await read(remote(peer, "/flynncode-sync/prefs"), isPrefsPayload)
    if (result.kind !== "ok" || result.value.prefs === null) return
    if (result.value.prefs.updatedAt <= (options.prefs.get()?.updatedAt ?? 0)) return
    options.prefs.apply(result.value.prefs)
  }

  async function cycle() {
    const status = await runCycle()
    state.status = status
    options.onStatus(status)
    return status
  }

  function schedule() {
    if (state.stopped) return
    clearTimeout(state.timer)
    state.timer = setTimeout(() => void run(), nextDelay(state.status, timing))
    state.timer.unref?.()
  }

  function run() {
    if (state.running) return state.running
    state.running = cycle().finally(() => {
      state.running = undefined
      schedule()
    })
    return state.running
  }

  return {
    cycle: run,
    start() {
      state.stopped = false
      void run()
    },
    stop() {
      state.stopped = true
      clearTimeout(state.timer)
    },
    syncNow: () => (state.running ? state.running.then(() => run()) : run()),
    status: () => state.status,
  }
}

async function read<T>(pending: Promise<Response | undefined>, guard: (value: unknown) => value is T): Promise<Fetched<T>> {
  const response = await pending
  if (!response) return { kind: "unreachable" }
  if (response.status === 401) return { kind: "unauthorized" }
  if (!response.ok) return { kind: "unreachable" }
  const body: unknown = await response.json().catch(() => undefined)
  return guard(body) ? { kind: "ok", value: body } : { kind: "invalid" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(value: unknown): value is { directories: string[] } {
  return isRecord(value) && Array.isArray(value.directories) && value.directories.every((item) => typeof item === "string")
}

function isSettings(value: unknown): value is { config: Record<string, unknown> | null; mtime: number } {
  return isRecord(value) && (value.config === null || isRecord(value.config)) && typeof value.mtime === "number"
}

function isPrefsPayload(value: unknown): value is { prefs: SyncPrefs | null } {
  if (!isRecord(value)) return false
  if (value.prefs === null) return true
  return isRecord(value.prefs) && isRecord(value.prefs.sections) && typeof value.prefs.updatedAt === "number"
}
```

- [ ] **Step 4: Export the worker**

In `packages/mobile-gateway/package.json` add `"./sync": "./src/sync-worker.ts",` to `exports` (next to `./sync-gate`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/mobile-gateway && bun test --timeout 30000`
Expected: PASS (all gateway tests including the 7 new worker tests).

- [ ] **Step 6: Typecheck**

Run: `cd packages/mobile-gateway && bun typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/mobile-gateway/src/sync-worker.ts packages/mobile-gateway/package.json packages/mobile-gateway/test/sync-worker.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile-gateway): add the machine sync worker loop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Desktop sidecar — sync start settings, live gateway reconcile, worker

**Files:**
- Modify: `packages/desktop/src/main/store-keys.ts` (append)
- Create: `packages/desktop/src/main/sidecar-sync.ts`
- Modify: `packages/desktop/src/main/mobile-gateway-launch.ts` (`startMobileGateway`, lines 28-49)
- Modify: `packages/desktop/src/main/sidecar.ts` (whole file shown below)
- Modify: `packages/desktop/src/main/server.ts` (`SpawnLocalServerOptions` lines 255-262; message wiring after line 319; start message lines 366-374; return value lines 403-419)
- Test: `packages/desktop/src/main/sidecar-sync.test.ts`; modify `packages/desktop/src/main/mobile-gateway-launch.test.ts`

**Interfaces:**
- Consumes: `createSyncGate`, `SyncGate`, `SyncPeer`, `SyncPrefs` (`@flynncode/mobile-gateway/sync-gate`), `createSyncWorker`, `SyncWorker`, `SyncStatus` (`@flynncode/mobile-gateway/sync`), `startGateway(... sync)` (Task 6).
- Produces:
  - Store keys `PHONE_ACCESS_KEY = "phoneAccess"`, `SYNC_PEER_KEY = "syncPeer"`, `SYNC_PAUSED_KEY = "syncPaused"`, `SYNC_PREFS_KEY = "syncPrefs"`.
  - `sidecar-sync.ts`: `type SidecarSyncStart = { machineName: string; phoneAccess: boolean; paused: boolean; peer: SyncPeer | null; prefs: SyncPrefs | null }`; `type SidecarSyncCommand = { type: "sync-config"; phoneAccess: boolean; paused: boolean; peer: SyncPeer | null } | { type: "sync-pairing-code"; code: string; expiresAt: number } | { type: "sync-now"; requestID: string } | { type: "sync-prefs"; prefs: SyncPrefs }`; `type SidecarSyncMessage = { type: "sync-paired"; peer: SyncPeer } | { type: "sync-unpaired" } | { type: "sync-status"; status: SyncStatus; requestID?: string } | { type: "sync-peer-prefs"; prefs: SyncPrefs }`; `parsePeer(value: unknown): SyncPeer | undefined`; `parsePrefs(value: unknown): SyncPrefs | undefined`; `parseSyncStart(value: unknown): SidecarSyncStart | undefined`; `parseSyncCommand(value: unknown): SidecarSyncCommand | undefined`; `isSyncMessage(value: unknown): value is SidecarSyncMessage`; `gatewayWanted(input: { phoneAccess: boolean; peer: SyncPeer | undefined; pairingActive: boolean }): boolean`.
  - `startMobileGateway(input: { …existing; sync?: SyncGate })`.
  - `spawnLocalServer(..., options: { …existing; sync: SidecarSyncStart; onSyncMessage?: (message: SidecarSyncMessage) => void })` returns `{ listener, health, post(command: SidecarSyncCommand): void }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/desktop/src/main/sidecar-sync.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { gatewayWanted, isSyncMessage, parsePrefs, parseSyncCommand, parseSyncStart } from "./sidecar-sync"

const peer = { name: "starship", url: "http://192.168.1.20:4097", token: "a".repeat(64) }

describe("parseSyncStart", () => {
  test("accepts an unpaired machine with phone access off", () => {
    expect(parseSyncStart({ machineName: "challenger", phoneAccess: false, paused: false, peer: null, prefs: null })).toEqual({
      machineName: "challenger",
      phoneAccess: false,
      paused: false,
      peer: null,
      prefs: null,
    })
  })

  test("keeps a well-formed peer and prefs", () => {
    const prefs = { sections: { appearance: { fontSize: 15 } }, updatedAt: 3 }
    expect(parseSyncStart({ machineName: "challenger", phoneAccess: true, paused: true, peer, prefs })).toEqual({
      machineName: "challenger",
      phoneAccess: true,
      paused: true,
      peer,
      prefs,
    })
  })

  test("rejects malformed settings", () => {
    expect(parseSyncStart(undefined)).toBeUndefined()
    expect(parseSyncStart({ machineName: "x", phoneAccess: "yes", paused: false, peer: null, prefs: null })).toBeUndefined()
    expect(parseSyncStart({ machineName: "x", phoneAccess: true, paused: false, peer: { name: "x" }, prefs: null })).toBeUndefined()
    expect(parsePrefs({ sections: [], updatedAt: 1 })).toBeUndefined()
  })
})

describe("parseSyncCommand", () => {
  test("parses every command and ignores the start/stop protocol", () => {
    expect(parseSyncCommand({ type: "sync-config", phoneAccess: true, paused: false, peer: null })).toEqual({
      type: "sync-config",
      phoneAccess: true,
      paused: false,
      peer: null,
    })
    expect(parseSyncCommand({ type: "sync-pairing-code", code: "123456", expiresAt: 5 })).toEqual({
      type: "sync-pairing-code",
      code: "123456",
      expiresAt: 5,
    })
    expect(parseSyncCommand({ type: "sync-now", requestID: "r1" })).toEqual({ type: "sync-now", requestID: "r1" })
    expect(parseSyncCommand({ type: "sync-prefs", prefs: { sections: {}, updatedAt: 1 } })).toEqual({
      type: "sync-prefs",
      prefs: { sections: {}, updatedAt: 1 },
    })
    expect(parseSyncCommand({ type: "stop" })).toBeUndefined()
    expect(parseSyncCommand({ type: "sync-pairing-code", code: 123456, expiresAt: 5 })).toBeUndefined()
  })
})

describe("isSyncMessage", () => {
  test("recognises sidecar sync messages only", () => {
    expect(isSyncMessage({ type: "sync-paired", peer })).toBe(true)
    expect(isSyncMessage({ type: "sync-unpaired" })).toBe(true)
    expect(isSyncMessage({ type: "sync-status", status: { phase: "idle" } })).toBe(true)
    expect(isSyncMessage({ type: "sync-peer-prefs", prefs: { sections: {}, updatedAt: 1 } })).toBe(true)
    expect(isSyncMessage({ type: "ready" })).toBe(false)
    expect(isSyncMessage({ type: "sync-paired", peer: {} })).toBe(false)
  })
})

describe("gatewayWanted", () => {
  test("stays off with phone access off and nothing paired", () => {
    expect(gatewayWanted({ phoneAccess: false, peer: undefined, pairingActive: false })).toBe(false)
  })

  test("runs for phone access, a paired peer, or a waiting pairing code", () => {
    expect(gatewayWanted({ phoneAccess: true, peer: undefined, pairingActive: false })).toBe(true)
    expect(gatewayWanted({ phoneAccess: false, peer, pairingActive: false })).toBe(true)
    expect(gatewayWanted({ phoneAccess: false, peer: undefined, pairingActive: true })).toBe(true)
  })
})
```

Append to the `describe("startMobileGateway", …)` block in `packages/desktop/src/main/mobile-gateway-launch.test.ts` (add `import { createSyncGate } from "@flynncode/mobile-gateway/sync-gate"` at the top):

```ts
  test("passes the sync gate through: phone routes 404 while sync stays token-gated", async () => {
    const sync = createSyncGate({
      machineName: "challenger",
      gatewayPort: 4097,
      phoneAccess: false,
      paused: false,
      peer: undefined,
      prefs: undefined,
    })
    const handle = await startMobileGateway({
      serverPassword: "upstream-secret",
      phonePassword: "phone-secret",
      port: 0,
      upstream: "http://127.0.0.1:9",
      relayToken: "",
      sync,
    })
    expect(handle).toBeDefined()
    if (!handle) return
    handles.push(handle)
    expect((await fetch(`http://127.0.0.1:${handle.port}/flynncode-mobile-status`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${handle.port}/flynncode-sync/manifest`)).status).toBe(401)
    sync.update({ phoneAccess: true })
    expect((await fetch(`http://127.0.0.1:${handle.port}/flynncode-mobile-status`)).status).toBe(200)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/desktop && bun test src/main/sidecar-sync.test.ts src/main/mobile-gateway-launch.test.ts`
Expected: FAIL — `Cannot find module './sidecar-sync'` (and the new launch test fails because `sync` is not passed to the gateway, so `/flynncode-mobile-status` answers 200).

- [ ] **Step 3: Add the store keys**

Append to `packages/desktop/src/main/store-keys.ts`:

```ts
// Machine sync and phone access. The peer record carries the pairing token;
// it reaches the sidecar only through its start/IPC messages.
export const PHONE_ACCESS_KEY = "phoneAccess"
export const SYNC_PEER_KEY = "syncPeer"
export const SYNC_PAUSED_KEY = "syncPaused"
export const SYNC_PREFS_KEY = "syncPrefs"
```

- [ ] **Step 4: Implement the sidecar sync protocol helpers**

Create `packages/desktop/src/main/sidecar-sync.ts`:

```ts
import type { SyncStatus } from "@flynncode/mobile-gateway/sync"
import type { SyncPeer, SyncPrefs } from "@flynncode/mobile-gateway/sync-gate"

export type SidecarSyncStart = {
  machineName: string
  phoneAccess: boolean
  paused: boolean
  peer: SyncPeer | null
  prefs: SyncPrefs | null
}

export type SidecarSyncCommand =
  | { type: "sync-config"; phoneAccess: boolean; paused: boolean; peer: SyncPeer | null }
  | { type: "sync-pairing-code"; code: string; expiresAt: number }
  | { type: "sync-now"; requestID: string }
  | { type: "sync-prefs"; prefs: SyncPrefs }

export type SidecarSyncMessage =
  | { type: "sync-paired"; peer: SyncPeer }
  | { type: "sync-unpaired" }
  | { type: "sync-status"; status: SyncStatus; requestID?: string }
  | { type: "sync-peer-prefs"; prefs: SyncPrefs }

export function parsePeer(value: unknown): SyncPeer | undefined {
  if (!isRecord(value)) return
  if (typeof value.name !== "string" || typeof value.url !== "string" || typeof value.token !== "string") return
  if (!value.token) return
  return { name: value.name, url: value.url, token: value.token }
}

export function parsePrefs(value: unknown): SyncPrefs | undefined {
  if (!isRecord(value) || !isRecord(value.sections) || typeof value.updatedAt !== "number") return
  return { sections: value.sections, updatedAt: value.updatedAt }
}

export function parseSyncStart(value: unknown): SidecarSyncStart | undefined {
  if (!isRecord(value) || typeof value.machineName !== "string") return
  if (typeof value.phoneAccess !== "boolean" || typeof value.paused !== "boolean") return
  const peer = value.peer === null ? null : parsePeer(value.peer)
  const prefs = value.prefs === null ? null : parsePrefs(value.prefs)
  if (peer === undefined || prefs === undefined) return
  return { machineName: value.machineName, phoneAccess: value.phoneAccess, paused: value.paused, peer, prefs }
}

export function parseSyncCommand(value: unknown): SidecarSyncCommand | undefined {
  if (!isRecord(value)) return
  if (value.type === "sync-config") {
    if (typeof value.phoneAccess !== "boolean" || typeof value.paused !== "boolean") return
    const peer = value.peer === null ? null : parsePeer(value.peer)
    if (peer === undefined) return
    return { type: "sync-config", phoneAccess: value.phoneAccess, paused: value.paused, peer }
  }
  if (value.type === "sync-pairing-code") {
    if (typeof value.code !== "string" || typeof value.expiresAt !== "number") return
    return { type: "sync-pairing-code", code: value.code, expiresAt: value.expiresAt }
  }
  if (value.type === "sync-now") {
    if (typeof value.requestID !== "string") return
    return { type: "sync-now", requestID: value.requestID }
  }
  if (value.type === "sync-prefs") {
    const prefs = parsePrefs(value.prefs)
    if (!prefs) return
    return { type: "sync-prefs", prefs }
  }
  return
}

export function isSyncMessage(value: unknown): value is SidecarSyncMessage {
  if (!isRecord(value)) return false
  if (value.type === "sync-paired") return parsePeer(value.peer) !== undefined
  if (value.type === "sync-unpaired") return true
  if (value.type === "sync-status") return isRecord(value.status)
  if (value.type === "sync-peer-prefs") return parsePrefs(value.prefs) !== undefined
  return false
}

// The LAN gateway only listens while something needs it: phone access, a
// paired peer, or a pairing code waiting to be used.
export function gatewayWanted(input: { phoneAccess: boolean; peer: SyncPeer | undefined; pairingActive: boolean }) {
  return input.phoneAccess || input.peer !== undefined || input.pairingActive
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
```

- [ ] **Step 5: Pass the gate to the gateway**

In `packages/desktop/src/main/mobile-gateway-launch.ts` add `import type { SyncGate } from "@flynncode/mobile-gateway/sync-gate"` and change `startMobileGateway`:

```ts
export async function startMobileGateway(input: {
  serverPassword: string
  phonePassword: string
  port: number
  upstream: string
  relayToken: string
  host?: string
  sync?: SyncGate
}): Promise<MobileGatewayHandle | undefined> {
  try {
    const resolved = resolveOptions(mobileGatewayEnv(input), input.upstream)
    if (!resolved.ok) {
      console.warn(`[mobile-gateway] disabled: ${resolved.reason}`)
      return
    }
    const gateway = await startGateway({ options: resolved.value, sync: input.sync })
    console.log(`[mobile-gateway] listening on http://${resolved.value.host}:${gateway.port}`)
    return gateway
  } catch (error) {
    console.warn(`[mobile-gateway] failed to start: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
}
```

- [ ] **Step 6: Run the sidecar sync wiring in the sidecar**

Replace `packages/desktop/src/main/sidecar.ts` with:

```ts
import * as http from "node:http"
import * as tls from "node:tls"
import { hostname } from "node:os"
import { createSyncWorker, type SyncWorker } from "@flynncode/mobile-gateway/sync"
import { createSyncGate, type SyncGate } from "@flynncode/mobile-gateway/sync-gate"
import {
  mobileGatewayUpstream,
  startMobileGateway,
  type MobileGatewayHandle,
} from "./mobile-gateway-launch"
import { startRelayPublisher, relayPublisherConfig } from "./relay-publisher"
import {
  gatewayWanted,
  parseSyncCommand,
  parseSyncStart,
  type SidecarSyncCommand,
  type SidecarSyncMessage,
  type SidecarSyncStart,
} from "./sidecar-sync"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  mobile: { password: string; port: number }
  // Relay secrets travel in the start message rather than the sidecar env so
  // they never leak into agent shells, which inherit process.env.
  relay: RelaySettings
  // The sync peer record (with its pairing token) follows the same rule.
  sync: SidecarSyncStart
}

type RelaySettings = { token: string; remoteToken: string; url: string }

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }
  | SidecarSyncMessage

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined
let mobileGateway: MobileGatewayHandle | undefined
let relayPublisher: { stop(): void } | undefined
let syncGate: SyncGate | undefined
let syncWorker: SyncWorker | undefined
let gatewayConfig: { command: StartCommand; upstream: string } | undefined
let gatewayQueue: Promise<void> = Promise.resolve()
let pairingTimer: ReturnType<typeof setTimeout> | undefined

parentPort.on("message", (event) => {
  const sync = parseSyncCommand(event.data)
  if (sync) {
    void handleSyncCommand(sync)
    return
  }
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    prepareSidecarEnv(command.password, command.userDataPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const { Server } = await import("virtual:opencode-server")

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    const upstream = mobileGatewayUpstream(command.hostname, command.port)
    const gate = createSyncGate({
      machineName: command.sync.machineName,
      gatewayPort: command.mobile.port,
      phoneAccess: command.sync.phoneAccess,
      paused: command.sync.paused,
      peer: command.sync.peer ?? undefined,
      prefs: command.sync.prefs ?? undefined,
      onPaired: (peer) => {
        post({ type: "sync-paired", peer })
        void reconcileGateway()
        void syncWorker?.syncNow()
      },
      onUnpaired: () => {
        post({ type: "sync-unpaired" })
        void reconcileGateway()
      },
    })
    syncGate = gate
    gatewayConfig = { command, upstream }
    await reconcileGateway()
    syncWorker = createSyncWorker({
      local: { url: upstream, authorization: `Basic ${Buffer.from(`opencode:${command.password}`).toString("base64")}` },
      peer: () => gate.peer(),
      paused: () => gate.paused(),
      prefs: {
        get: () => gate.prefs(),
        apply: (prefs) => {
          gate.update({ prefs })
          post({ type: "sync-peer-prefs", prefs })
        },
      },
      takeSent: () => gate.takeSent(),
      onStatus: (status) => post({ type: "sync-status", status }),
    })
    syncWorker.start()
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    syncWorker?.stop()
    syncWorker = undefined
    clearTimeout(pairingTimer)
    relayPublisher?.stop()
    relayPublisher = undefined
    mobileGateway?.stop()
    mobileGateway = undefined
    // Disposing instances shuts down MCP servers (with their process trees), LSPs and
    // shells; closing the listener alone leaves them orphaned when this process exits.
    const { InstanceRuntime } = await import("virtual:opencode-server")
    await InstanceRuntime.disposeAllInstances()
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

async function handleSyncCommand(command: SidecarSyncCommand) {
  const gate = syncGate
  if (!gate) return
  if (command.type === "sync-config") {
    const peerChanged = command.peer?.token !== gate.peer()?.token
    gate.update({ phoneAccess: command.phoneAccess, paused: command.paused, peer: command.peer })
    await reconcileGateway()
    if (peerChanged && command.peer) void syncWorker?.syncNow()
    return
  }
  if (command.type === "sync-pairing-code") {
    gate.setPairingCode({ code: command.code, expiresAt: command.expiresAt })
    clearTimeout(pairingTimer)
    // A gateway started only for pairing shuts down again once the code expires.
    pairingTimer = setTimeout(() => void reconcileGateway(), Math.max(0, command.expiresAt - Date.now()) + 1000)
    await reconcileGateway()
    return
  }
  if (command.type === "sync-prefs") {
    gate.update({ prefs: command.prefs })
    return
  }
  const status = await syncWorker?.syncNow()
  if (status) post({ type: "sync-status", status, requestID: command.requestID })
}

// Serialised so overlapping toggles never start two gateways on port 4097.
function reconcileGateway() {
  gatewayQueue = gatewayQueue.then(applyGatewayState, applyGatewayState)
  return gatewayQueue
}

// The gateway runs while phone access is on, a peer is paired, or a pairing
// code is waiting; the relay publisher only runs with phone access, since it
// reads the phone inbox.
async function applyGatewayState() {
  const gate = syncGate
  const config = gatewayConfig
  if (!gate || !config) return
  const wanted = gatewayWanted({ phoneAccess: gate.phoneAccess(), peer: gate.peer(), pairingActive: gate.pairingActive() })
  if (wanted && !mobileGateway) {
    mobileGateway = await startMobileGateway({
      serverPassword: config.command.password,
      phonePassword: config.command.mobile.password,
      port: config.command.mobile.port,
      upstream: config.upstream,
      relayToken: config.command.relay.token,
      host: process.env.OPENCODE_MOBILE_HOST,
      sync: gate,
    })
  }
  if (!wanted && mobileGateway) {
    mobileGateway.stop()
    mobileGateway = undefined
  }
  const relayWanted = gate.phoneAccess() && mobileGateway !== undefined
  if (relayWanted && !relayPublisher) {
    relayPublisher = startRelayPublisherFor({
      relay: config.command.relay,
      gatewayPort: mobileGateway?.port,
      phonePassword: config.command.mobile.password,
    })
  }
  if (!relayWanted && relayPublisher) {
    relayPublisher.stop()
    relayPublisher = undefined
  }
}

function post(message: SidecarSyncMessage) {
  parentPort.postMessage(message)
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  const mobile = (command as { mobile?: unknown }).mobile
  if (!mobile || typeof mobile !== "object") return
  const mobilePassword = (mobile as { password?: unknown }).password
  const mobilePort = (mobile as { port?: unknown }).port
  if (typeof mobilePassword !== "string" || mobilePassword === "") return
  if (typeof mobilePort !== "number" || !Number.isInteger(mobilePort) || mobilePort < 0 || mobilePort > 65535) {
    return
  }
  const relay = parseRelaySettings((command as { relay?: unknown }).relay)
  if (!relay) return
  const sync = parseSyncStart((command as { sync?: unknown }).sync)
  if (!sync) return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    mobile: { password: mobilePassword, port: mobilePort },
    relay,
    sync,
  }
}

function parseRelaySettings(value: unknown): RelaySettings | undefined {
  if (!value || typeof value !== "object") return
  const relay = value as Partial<Record<keyof RelaySettings, unknown>>
  if (typeof relay.token !== "string") return
  if (typeof relay.remoteToken !== "string") return
  if (typeof relay.url !== "string") return
  return { token: relay.token, remoteToken: relay.remoteToken, url: relay.url }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

// The relay publisher pushes needs-input digests to the deepthought host so
// the phone sees them while away. It stays off unless the outbound remote
// token and the deepthought gateway URL are both configured; originID reuses
// the machine hostname rather than inventing a new identity.
function startRelayPublisherFor(input: {
  relay: RelaySettings
  gatewayPort: number | undefined
  phonePassword: string
}) {
  const config = relayPublisherConfig(
    { remoteToken: input.relay.remoteToken, url: input.relay.url },
    { gatewayPort: input.gatewayPort, phonePassword: input.phonePassword, originID: hostname() },
  )
  if (!config) return
  return startRelayPublisher(config)
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
```

- [ ] **Step 7: Carry sync through `spawnLocalServer`**

In `packages/desktop/src/main/server.ts`:

1. Add `import { isSyncMessage, type SidecarSyncCommand, type SidecarSyncMessage, type SidecarSyncStart } from "./sidecar-sync"` after the `MOBILE_GATEWAY_PORT` import.

2. Extend `SpawnLocalServerOptions`:

```ts
type SpawnLocalServerOptions = {
  userDataPath: string
  mobilePassword: string
  relay: { token: string; remoteToken: string; url: string }
  sync: SidecarSyncStart
  onSyncMessage?: (message: SidecarSyncMessage) => void
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}
```

3. After `child.stderr?.on("data", …)` add:

```ts
  // Sync messages (pairing, status, peer prefs) arrive for the sidecar's
  // whole lifetime, not only during startup.
  child.on("message", (message: unknown) => {
    if (isSyncMessage(message)) options.onSyncMessage?.(message)
  })
```

4. In the `child.postMessage({ type: "start", … })` call add `sync: options.sync,` after `relay: options.relay,`.

5. Return the sender alongside the listener (replace the final `return { listener: {…}, health: { wait } }`):

```ts
  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
    post: (command: SidecarSyncCommand) => {
      if (!exited) child.postMessage(command)
    },
  }
```

6. In `packages/desktop/src/main/index.ts` the `spawnLocalServer(...)` call must now pass `sync`. The loading task already has a local `const hostname = "127.0.0.1"` (line 402), which would shadow `os.hostname`, and aliased imports are not allowed, so rename that local to `host` and update its two uses (`const url = \`http://${host}:${port}\`` and `spawnLocalServer(host, port, password, {`). Then change line 5 to `import { homedir, hostname, tmpdir } from "node:os"`, add `import { parseSyncStart } from "./sidecar-sync"`, extend the store-keys import on line 55 with `PHONE_ACCESS_KEY, SYNC_PAUSED_KEY, SYNC_PEER_KEY, SYNC_PREFS_KEY`, and add to the `spawnLocalServer` options object (after `relay,`):

```ts
        sync: parseSyncStart({
          machineName: hostname(),
          phoneAccess: persisted.get(PHONE_ACCESS_KEY) === true,
          paused: persisted.get(SYNC_PAUSED_KEY) === true,
          peer: persisted.get(SYNC_PEER_KEY) ?? null,
          prefs: persisted.get(SYNC_PREFS_KEY) ?? null,
        }) ?? { machineName: hostname(), phoneAccess: false, paused: false, peer: null, prefs: null },
```

(Task 9 replaces this expression with `readSyncStart(syncStore, hostname())`.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd packages/desktop && bun test src/main/sidecar-sync.test.ts src/main/mobile-gateway-launch.test.ts src/main/relay-publisher.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `cd packages/desktop && bun typecheck`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git add packages/desktop/src/main/store-keys.ts packages/desktop/src/main/sidecar-sync.ts packages/desktop/src/main/sidecar-sync.test.ts packages/desktop/src/main/sidecar.ts packages/desktop/src/main/mobile-gateway-launch.ts packages/desktop/src/main/mobile-gateway-launch.test.ts packages/desktop/src/main/server.ts packages/desktop/src/main/index.ts
git commit -m "$(cat <<'EOF'
feat(desktop): run machine sync and gate the gateway in the sidecar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Desktop main — pairing storage, controller, IPC and preload

**Files:**
- Create: `packages/app/src/context/machine-sync-types.ts`
- Modify: `packages/app/package.json` (`exports`)
- Create: `packages/desktop/src/main/machine-sync.ts`
- Modify: `packages/desktop/src/main/ipc.ts` (imports lines 1-31; `Deps` lines 75-99; handlers after the `rotate-mobile-phone-password` handler, line 158)
- Modify: `packages/desktop/src/main/index.ts` (imports; before `registerIpcHandlers(` line 306; the loading task's `spawnLocalServer` call lines 445-456)
- Modify: `packages/desktop/src/preload/types.ts` (imports; `ElectronAPI` after `rotateMobilePhonePassword`)
- Modify: `packages/desktop/src/preload/index.ts` (after `rotateMobilePhonePassword`, line 76)
- Test: `packages/desktop/src/main/machine-sync.test.ts`

**Interfaces:**
- Consumes: `pairWithPeer`, `unpairPeer` (Task 6), `PAIRING_CODE_TTL_MS`, `SyncPrefs` (Task 6), `SyncStatus` (Task 7), `SidecarSyncCommand`, `SidecarSyncMessage`, `SidecarSyncStart`, `parsePeer`, `parsePrefs` (Task 8), store keys (Task 8), `listLanIPv4` (`@flynncode/mobile-gateway/lan-ips`).
- Produces:
  - `packages/app/src/context/machine-sync-types.ts`: `MachineSyncPhase`, `MachineSyncStatus = { paired: boolean; peerName: string | null; paused: boolean; phase: MachineSyncPhase; online: boolean; lastSuccess: number | null; received: number; sent: number; missingDirectories: string[]; backlog: { done: number; total: number } | null; failures: Array<{ id: string; error: string }>; lastError: string | null; machineName: string; addresses: string[] }`, `MachineSyncPairingCode = { code: string; expiresAt: number; machineName: string; addresses: string[] }`, `MachineSyncPairResult = { ok: true } | { ok: false; reason: "unreachable" | "invalid-code" | "failed" }`, `MachineSyncPrefs = { sections: Record<string, unknown>; updatedAt: number }`, `MachineSyncPlatform = { status(): Promise<MachineSyncStatus>; subscribe(cb): () => void; createPairingCode(): Promise<MachineSyncPairingCode>; pair(input: { host: string; code: string }): Promise<MachineSyncPairResult>; syncNow(): Promise<MachineSyncStatus>; setPaused(paused: boolean): Promise<void>; unpair(): Promise<void>; pushPrefs(prefs: MachineSyncPrefs): Promise<MachineSyncPrefs | null>; onPeerPrefs(cb): () => void }`; package export `"./machine-sync-types"`.
  - `packages/desktop/src/main/machine-sync.ts`: `type SyncStore = { get(key: string): unknown; set(key: string, value: unknown): void; delete(key: string): void }`; `readSyncStart(store: SyncStore, machineName: string): SidecarSyncStart`; `createMachineSync(deps: { store: SyncStore; machineName: string; post(command: SidecarSyncCommand): void; broadcast(channel: "machine-sync-status" | "machine-sync-peer-prefs", payload: unknown): void; lanAddresses(): string[]; fetchImpl?: typeof fetch; now?: () => number; code?: () => string })` → `{ status(): MachineSyncStatus; phoneAccess(): boolean; setPhoneAccess(enabled: boolean): void; setPaused(paused: boolean): void; createPairingCode(): MachineSyncPairingCode; pair(input: { host: string; code: string }): Promise<MachineSyncPairResult>; unpair(): Promise<void>; syncNow(): Promise<MachineSyncStatus>; pushPrefs(prefs: SyncPrefs): SyncPrefs | undefined; handleSidecarMessage(message: SidecarSyncMessage): void }`; `type MachineSync = ReturnType<typeof createMachineSync>`.
  - IPC channels (invoke): `machine-sync-status`, `machine-sync-create-code`, `machine-sync-pair(host, code)`, `machine-sync-unpair`, `machine-sync-now`, `machine-sync-set-paused(paused)`, `machine-sync-push-prefs(prefs)`, `get-phone-access`, `set-phone-access(enabled)`; events: `machine-sync-status`, `machine-sync-peer-prefs`.
  - `ElectronAPI.getPhoneAccess(): Promise<boolean>`, `ElectronAPI.setPhoneAccess(enabled: boolean): Promise<void>`, `ElectronAPI.machineSync: MachineSyncPlatform`.

- [ ] **Step 1: Write the failing test**

Create `packages/desktop/src/main/machine-sync.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { createGateway } from "@flynncode/mobile-gateway/gateway"
import { createSyncGate } from "@flynncode/mobile-gateway/sync-gate"
import { initialStatus } from "@flynncode/mobile-gateway/sync"
import { createMachineSync, readSyncStart, type SyncStore } from "./machine-sync"
import type { SidecarSyncCommand } from "./sidecar-sync"

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  while (servers.length) servers.pop()?.stop(true)
})

function memoryStore() {
  const values = new Map<string, unknown>()
  const store: SyncStore = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value)
    },
    delete: (key) => {
      values.delete(key)
    },
  }
  return { values, store }
}

function controller() {
  const memory = memoryStore()
  const posted: SidecarSyncCommand[] = []
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  const sync = createMachineSync({
    store: memory.store,
    machineName: "starship",
    post: (command) => posted.push(command),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    lanAddresses: () => ["192.168.1.20"],
    now: () => 1_000,
    code: () => "123456",
  })
  return { values: memory.values, posted, broadcasts, sync }
}

// Machine A: a real gateway with a pairing code, as the other computer.
function peerMachine() {
  const gate = createSyncGate({
    machineName: "challenger",
    gatewayPort: 4097,
    phoneAccess: false,
    paused: false,
    peer: undefined,
    prefs: undefined,
  })
  gate.setPairingCode({ code: "654321", expiresAt: Date.now() + 60_000 })
  const handle = createGateway({
    options: { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1:9", username: "opencode", password: "phone", upstreamPassword: "server", relayToken: "" },
    sync: gate,
  })
  const server = Bun.serve({ port: 0, fetch: (request, srv) => handle(request, srv.requestIP(request)?.address) })
  servers.push(server)
  return { gate, host: `127.0.0.1:${server.port}` }
}

describe("readSyncStart", () => {
  test("defaults to phone access off, unpaused and unpaired", () => {
    expect(readSyncStart(memoryStore().store, "starship")).toEqual({
      machineName: "starship",
      phoneAccess: false,
      paused: false,
      peer: null,
      prefs: null,
    })
  })
})

describe("createMachineSync", () => {
  test("persists phone access and pushes it to the sidecar live", () => {
    const { values, posted, sync } = controller()
    sync.setPhoneAccess(true)
    expect(values.get("phoneAccess")).toBe(true)
    expect(sync.phoneAccess()).toBe(true)
    expect(posted.at(-1)).toEqual({ type: "sync-config", phoneAccess: true, paused: false, peer: null })
  })

  test("creates a six-digit pairing code valid for ten minutes", () => {
    const { posted, sync } = controller()
    expect(sync.createPairingCode()).toEqual({
      code: "123456",
      expiresAt: 601_000,
      machineName: "starship",
      addresses: ["192.168.1.20"],
    })
    expect(posted).toEqual([{ type: "sync-pairing-code", code: "123456", expiresAt: 601_000 }])
  })

  test("pairs with the other machine, stores the peer, then unpairs on both sides", async () => {
    const peer = peerMachine()
    const { values, posted, broadcasts, sync } = controller()
    expect(await sync.pair({ host: peer.host, code: "000000" })).toEqual({ ok: false, reason: "invalid-code" })
    expect(await sync.pair({ host: peer.host, code: "654321" })).toEqual({ ok: true })
    const stored = values.get("syncPeer") as { name: string; url: string; token: string }
    expect(stored.name).toBe("challenger")
    expect(stored.url).toBe(`http://${peer.host}`)
    expect(stored.token).toMatch(/^[0-9a-f]{64}$/)
    expect(peer.gate.peer()?.token).toBe(stored.token)
    expect(posted.at(-1)).toEqual({ type: "sync-config", phoneAccess: false, paused: false, peer: stored })
    expect(broadcasts.at(-1)?.payload).toMatchObject({ paired: true, peerName: "challenger" })

    await sync.unpair()
    expect(values.has("syncPeer")).toBe(false)
    expect(posted.at(-1)).toEqual({ type: "sync-config", phoneAccess: false, paused: false, peer: null })
    expect(peer.gate.peer()).toBeUndefined()
  })

  test("applies sidecar messages: paired, unpaired, peer prefs and status", () => {
    const { values, broadcasts, sync } = controller()
    const peer = { name: "challenger", url: "http://192.168.1.10:4097", token: "c".repeat(64) }
    sync.handleSidecarMessage({ type: "sync-paired", peer })
    expect(values.get("syncPeer")).toEqual(peer)
    sync.handleSidecarMessage({ type: "sync-status", status: { ...initialStatus(), phase: "idle", online: true, received: 4 } })
    expect(sync.status()).toMatchObject({ paired: true, peerName: "challenger", phase: "idle", online: true, received: 4 })
    const prefs = { sections: { appearance: { fontSize: 17 } }, updatedAt: 9 }
    sync.handleSidecarMessage({ type: "sync-peer-prefs", prefs })
    expect(values.get("syncPrefs")).toEqual(prefs)
    expect(broadcasts).toContainEqual({ channel: "machine-sync-peer-prefs", payload: prefs })
    sync.handleSidecarMessage({ type: "sync-unpaired" })
    expect(values.has("syncPeer")).toBe(false)
    expect(sync.status().phase).toBe("unpaired")
  })

  test("resolves Sync now with the matching sidecar status", async () => {
    const { posted, sync } = controller()
    const pending = sync.syncNow()
    const command = posted.at(-1)
    if (command?.type !== "sync-now") throw new Error("expected a sync-now command")
    sync.handleSidecarMessage({ type: "sync-status", status: { ...initialStatus(), phase: "offline" }, requestID: command.requestID })
    expect((await pending).phase).toBe("unpaired")
  })

  test("keeps newer stored prefs and hands them back to an older window", () => {
    const { values, posted, sync } = controller()
    expect(sync.pushPrefs({ sections: { sounds: {} }, updatedAt: 10 })).toBeUndefined()
    expect(values.get("syncPrefs")).toEqual({ sections: { sounds: {} }, updatedAt: 10 })
    expect(posted.at(-1)).toEqual({ type: "sync-prefs", prefs: { sections: { sounds: {} }, updatedAt: 10 } })
    expect(sync.pushPrefs({ sections: {}, updatedAt: 5 })).toEqual({ sections: { sounds: {} }, updatedAt: 10 })
  })
})
```

(The Sync-now test resolves to `"unpaired"` because no peer is stored: the controller always reports `unpaired` without a peer, whatever the worker said.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && bun test src/main/machine-sync.test.ts`
Expected: FAIL — `Cannot find module './machine-sync'`.

- [ ] **Step 3: Add the renderer-facing types**

Create `packages/app/src/context/machine-sync-types.ts`:

```ts
export type MachineSyncPhase = "idle" | "offline" | "mismatch" | "unauthorized" | "paused" | "unpaired"

export type MachineSyncStatus = {
  paired: boolean
  peerName: string | null
  paused: boolean
  phase: MachineSyncPhase
  online: boolean
  lastSuccess: number | null
  received: number
  sent: number
  missingDirectories: string[]
  backlog: { done: number; total: number } | null
  failures: Array<{ id: string; error: string }>
  lastError: string | null
  machineName: string
  addresses: string[]
}

export type MachineSyncPairingCode = { code: string; expiresAt: number; machineName: string; addresses: string[] }

export type MachineSyncPairResult = { ok: true } | { ok: false; reason: "unreachable" | "invalid-code" | "failed" }

export type MachineSyncPrefs = { sections: Record<string, unknown>; updatedAt: number }

export type MachineSyncPlatform = {
  status(): Promise<MachineSyncStatus>
  subscribe(cb: (status: MachineSyncStatus) => void): () => void
  createPairingCode(): Promise<MachineSyncPairingCode>
  pair(input: { host: string; code: string }): Promise<MachineSyncPairResult>
  syncNow(): Promise<MachineSyncStatus>
  setPaused(paused: boolean): Promise<void>
  unpair(): Promise<void>
  /** Returns newer prefs the desktop already holds, for this window to apply. */
  pushPrefs(prefs: MachineSyncPrefs): Promise<MachineSyncPrefs | null>
  onPeerPrefs(cb: (prefs: MachineSyncPrefs) => void): () => void
}
```

In `packages/app/package.json` add to `exports` after `"./components/settings-v2/plugins-types"`:

```json
    "./machine-sync-types": "./src/context/machine-sync-types.ts",
```

- [ ] **Step 4: Implement the main-process controller**

Create `packages/desktop/src/main/machine-sync.ts`:

```ts
import { randomInt, randomUUID } from "node:crypto"
import type { SyncStatus } from "@flynncode/mobile-gateway/sync"
import { PAIRING_CODE_TTL_MS, type SyncPrefs } from "@flynncode/mobile-gateway/sync-gate"
import { pairWithPeer, unpairPeer } from "@flynncode/mobile-gateway/sync-pair"
import type {
  MachineSyncPairingCode,
  MachineSyncPairResult,
  MachineSyncStatus,
} from "@opencode-ai/app/machine-sync-types"
import {
  parsePeer,
  parsePrefs,
  type SidecarSyncCommand,
  type SidecarSyncMessage,
  type SidecarSyncStart,
} from "./sidecar-sync"
import { PHONE_ACCESS_KEY, SYNC_PAUSED_KEY, SYNC_PEER_KEY, SYNC_PREFS_KEY } from "./store-keys"

const SYNC_NOW_TIMEOUT_MS = 120_000

export type SyncStore = {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
}

export type MachineSync = ReturnType<typeof createMachineSync>

export function readSyncStart(store: SyncStore, machineName: string): SidecarSyncStart {
  return {
    machineName,
    phoneAccess: store.get(PHONE_ACCESS_KEY) === true,
    paused: store.get(SYNC_PAUSED_KEY) === true,
    peer: parsePeer(store.get(SYNC_PEER_KEY)) ?? null,
    prefs: parsePrefs(store.get(SYNC_PREFS_KEY)) ?? null,
  }
}

// Main owns the persisted sync settings; the sidecar owns the live gate and
// worker. Every change is written here first and then pushed to the sidecar,
// so a restart always starts from the stored state.
export function createMachineSync(deps: {
  store: SyncStore
  machineName: string
  post: (command: SidecarSyncCommand) => void
  broadcast: (channel: "machine-sync-status" | "machine-sync-peer-prefs", payload: unknown) => void
  lanAddresses: () => string[]
  fetchImpl?: typeof fetch
  now?: () => number
  code?: () => string
}) {
  const now = deps.now ?? Date.now
  const pending = new Map<string, (status: SyncStatus) => void>()
  const state = { worker: undefined as SyncStatus | undefined }

  const settings = () => readSyncStart(deps.store, deps.machineName)

  const pushConfig = () => {
    const current = settings()
    deps.post({ type: "sync-config", phoneAccess: current.phoneAccess, paused: current.paused, peer: current.peer })
  }

  const status = (): MachineSyncStatus => {
    const current = settings()
    const worker = state.worker
    return {
      paired: current.peer !== null,
      peerName: current.peer?.name ?? null,
      paused: current.paused,
      phase: current.peer === null ? "unpaired" : current.paused ? "paused" : (worker?.phase ?? "idle"),
      online: current.peer !== null && (worker?.online ?? false),
      lastSuccess: worker?.lastSuccess ?? null,
      received: worker?.received ?? 0,
      sent: worker?.sent ?? 0,
      missingDirectories: worker?.missingDirectories ?? [],
      backlog: worker?.backlog ?? null,
      failures: worker?.failures ?? [],
      lastError: worker?.lastError ?? null,
      machineName: deps.machineName,
      addresses: deps.lanAddresses(),
    }
  }

  const publish = () => deps.broadcast("machine-sync-status", status())

  return {
    status,
    phoneAccess: () => settings().phoneAccess,
    setPhoneAccess(enabled: boolean) {
      deps.store.set(PHONE_ACCESS_KEY, enabled)
      pushConfig()
    },
    setPaused(paused: boolean) {
      deps.store.set(SYNC_PAUSED_KEY, paused)
      pushConfig()
      publish()
    },
    createPairingCode(): MachineSyncPairingCode {
      const code = deps.code?.() ?? String(randomInt(0, 1_000_000)).padStart(6, "0")
      const expiresAt = now() + PAIRING_CODE_TTL_MS
      deps.post({ type: "sync-pairing-code", code, expiresAt })
      return { code, expiresAt, machineName: deps.machineName, addresses: deps.lanAddresses() }
    },
    async pair(input: { host: string; code: string }): Promise<MachineSyncPairResult> {
      const result = await pairWithPeer({ host: input.host, code: input.code, name: deps.machineName, fetchImpl: deps.fetchImpl })
      if (!result.ok) return { ok: false, reason: result.reason }
      deps.store.set(SYNC_PEER_KEY, result.peer)
      pushConfig()
      publish()
      return { ok: true }
    },
    async unpair() {
      const peer = settings().peer
      deps.store.delete(SYNC_PEER_KEY)
      pushConfig()
      publish()
      if (peer) await unpairPeer({ peer, fetchImpl: deps.fetchImpl })
    },
    syncNow() {
      const requestID = randomUUID()
      return new Promise<MachineSyncStatus>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestID)
          resolve(status())
        }, SYNC_NOW_TIMEOUT_MS)
        pending.set(requestID, () => {
          clearTimeout(timer)
          resolve(status())
        })
        deps.post({ type: "sync-now", requestID })
      })
    },
    pushPrefs(prefs: SyncPrefs): SyncPrefs | undefined {
      const stored = parsePrefs(deps.store.get(SYNC_PREFS_KEY))
      if (stored && stored.updatedAt > prefs.updatedAt) return stored
      deps.store.set(SYNC_PREFS_KEY, prefs)
      deps.post({ type: "sync-prefs", prefs })
      return undefined
    },
    handleSidecarMessage(message: SidecarSyncMessage) {
      if (message.type === "sync-paired") {
        deps.store.set(SYNC_PEER_KEY, message.peer)
        publish()
        return
      }
      if (message.type === "sync-unpaired") {
        deps.store.delete(SYNC_PEER_KEY)
        publish()
        return
      }
      if (message.type === "sync-peer-prefs") {
        deps.store.set(SYNC_PREFS_KEY, message.prefs)
        deps.broadcast("machine-sync-peer-prefs", message.prefs)
        return
      }
      state.worker = message.status
      const waiting = message.requestID === undefined ? undefined : pending.get(message.requestID)
      if (message.requestID !== undefined) pending.delete(message.requestID)
      waiting?.(message.status)
      publish()
    },
  }
}
```

- [ ] **Step 5: Register IPC handlers**

In `packages/desktop/src/main/ipc.ts`:

1. Add imports:

```ts
import type { MachineSync } from "./machine-sync"
import { parsePrefs } from "./sidecar-sync"
```

2. Add to `type Deps` after `setNativeTranslations`:

```ts
  machineSync: MachineSync
```

3. After the `rotate-mobile-phone-password` handler add:

```ts
  // Phone access and machine sync change the sidecar live; no restart needed.
  ipcMain.handle("get-phone-access", () => deps.machineSync.phoneAccess())
  ipcMain.handle("set-phone-access", (_event: IpcMainInvokeEvent, enabled: unknown) => {
    if (typeof enabled === "boolean") deps.machineSync.setPhoneAccess(enabled)
  })
  ipcMain.handle("machine-sync-status", () => deps.machineSync.status())
  ipcMain.handle("machine-sync-create-code", () => deps.machineSync.createPairingCode())
  ipcMain.handle("machine-sync-pair", (_event: IpcMainInvokeEvent, host: unknown, code: unknown) => {
    if (typeof host !== "string" || typeof code !== "string") return { ok: false, reason: "failed" }
    return deps.machineSync.pair({ host, code })
  })
  ipcMain.handle("machine-sync-unpair", () => deps.machineSync.unpair())
  ipcMain.handle("machine-sync-now", () => deps.machineSync.syncNow())
  ipcMain.handle("machine-sync-set-paused", (_event: IpcMainInvokeEvent, paused: unknown) => {
    if (typeof paused === "boolean") deps.machineSync.setPaused(paused)
  })
  ipcMain.handle("machine-sync-push-prefs", (_event: IpcMainInvokeEvent, prefs: unknown) => {
    const parsed = parsePrefs(prefs)
    if (!parsed) return null
    return deps.machineSync.pushPrefs(parsed) ?? null
  })
```

- [ ] **Step 6: Wire the controller in main**

In `packages/desktop/src/main/index.ts`:

1. Add imports:

```ts
import { listLanIPv4 } from "@flynncode/mobile-gateway/lan-ips"
import { createMachineSync, readSyncStart } from "./machine-sync"
import type { SidecarSyncCommand } from "./sidecar-sync"
```

and remove the Task 8 `import { parseSyncStart } from "./sidecar-sync"` plus the `PHONE_ACCESS_KEY, SYNC_PAUSED_KEY, SYNC_PEER_KEY, SYNC_PREFS_KEY` names from the store-keys import.

2. Directly before `registerIpcHandlers({` add:

```ts
  const syncStore = {
    get: (key: string) => getStore().get(key),
    set: (key: string, value: unknown) => getStore().set(key, value),
    delete: (key: string) => getStore().delete(key),
  }
  // The sidecar spawns later; commands sent before it exists are dropped
  // because its start message carries the same stored state.
  const sidecar: { post?: (command: SidecarSyncCommand) => void } = {}
  const machineSync = createMachineSync({
    store: syncStore,
    machineName: hostname(),
    post: (command) => sidecar.post?.(command),
    broadcast: (channel, payload) =>
      BrowserWindow.getAllWindows()
        .filter((win) => !win.isDestroyed())
        .forEach((win) => win.webContents.send(channel, payload)),
    lanAddresses: () => listLanIPv4(),
  })
```

3. Add `machineSync,` to the object passed to `registerIpcHandlers` (after `setNativeTranslations: …`).

4. In the loading task, replace the Task 8 `sync: parseSyncStart({ … }) ?? { … },` option with:

```ts
        sync: readSyncStart(syncStore, hostname()),
        onSyncMessage: (message) => machineSync.handleSidecarMessage(message),
```

and change `const { listener, health } = yield* Effect.promise(() =>` to `const { listener, health, post } = yield* Effect.promise(() =>`; after `server = listener` add `sidecar.post = post`.

- [ ] **Step 7: Expose the API in the preload**

In `packages/desktop/src/preload/types.ts` add `import type { MachineSyncPlatform } from "@opencode-ai/app/machine-sync-types"` and inside `ElectronAPI` after `rotateMobilePhonePassword: () => Promise<string>`:

```ts
  getPhoneAccess: () => Promise<boolean>
  setPhoneAccess: (enabled: boolean) => Promise<void>
  machineSync: MachineSyncPlatform
```

In `packages/desktop/src/preload/index.ts` add `import type { MachineSyncPrefs, MachineSyncStatus } from "@opencode-ai/app/machine-sync-types"` and after `rotateMobilePhonePassword: …,`:

```ts
  getPhoneAccess: () => ipcRenderer.invoke("get-phone-access"),
  setPhoneAccess: (enabled) => ipcRenderer.invoke("set-phone-access", enabled),
  machineSync: {
    status: () => ipcRenderer.invoke("machine-sync-status"),
    subscribe: (cb) => {
      const handler = (_: unknown, status: MachineSyncStatus) => cb(status)
      ipcRenderer.on("machine-sync-status", handler)
      return () => ipcRenderer.removeListener("machine-sync-status", handler)
    },
    createPairingCode: () => ipcRenderer.invoke("machine-sync-create-code"),
    pair: (input) => ipcRenderer.invoke("machine-sync-pair", input.host, input.code),
    syncNow: () => ipcRenderer.invoke("machine-sync-now"),
    setPaused: (paused) => ipcRenderer.invoke("machine-sync-set-paused", paused),
    unpair: () => ipcRenderer.invoke("machine-sync-unpair"),
    pushPrefs: (prefs) => ipcRenderer.invoke("machine-sync-push-prefs", prefs),
    onPeerPrefs: (cb) => {
      const handler = (_: unknown, prefs: MachineSyncPrefs) => cb(prefs)
      ipcRenderer.on("machine-sync-peer-prefs", handler)
      return () => ipcRenderer.removeListener("machine-sync-peer-prefs", handler)
    },
  },
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd packages/desktop && bun test src/main/machine-sync.test.ts src/main/sidecar-sync.test.ts src/main/mobile-gateway-launch.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `cd packages/app && bun typecheck` then `cd packages/desktop && bun typecheck`
Expected: both exit 0.

- [ ] **Step 10: Commit**

```bash
git add packages/app/src/context/machine-sync-types.ts packages/app/package.json packages/desktop/src/main/machine-sync.ts packages/desktop/src/main/machine-sync.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/types.ts packages/desktop/src/preload/index.ts
git commit -m "$(cat <<'EOF'
feat(desktop): store sync pairing and expose machine sync over IPC

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: App preferences sync in the renderer

**Files:**
- Modify: `packages/app/src/context/platform.tsx` (imports lines 1-9; `PlatformBase` after the `plugins?` field, line ~91)
- Create: `packages/app/src/context/settings-sync.ts`
- Modify: `packages/app/src/context/settings.tsx` (imports lines 1-5; `Settings` interface lines 22-56; inside `init` after the `followup` effect, line ~364)
- Modify: `packages/desktop/src/renderer/index.tsx` (platform object, after the `plugins: { … },` entry ~line 297)
- Test: `packages/app/src/context/settings-sync.test.ts`

**Interfaces:**
- Consumes: `MachineSyncPlatform`, `MachineSyncPrefs` (Task 9), `persisted("settings.v3", …)` store in `settings.tsx`, `window.api.machineSync` (Task 9).
- Produces:
  - `Platform.machineSync?: MachineSyncPlatform`
  - `Settings.syncUpdatedAt?: number`
  - `settings-sync.ts`: `SYNCED_SECTIONS = ["general", "appearance", "keybinds", "notifications", "sounds"] as const`, `type SyncedSection`, `LOCAL_GENERAL_KEYS` (the five launch-state flags), `syncableSections(settings: Settings): Record<string, unknown>`, `syncKey(sections: Record<string, unknown>): string` (stable, key-order independent), `mergePeerSections(current: Settings, peer: MachineSyncPrefs): Partial<Pick<Settings, SyncedSection>>`.
  - Behaviour: after `ready()`, the first snapshot is pushed with the stored stamp; every later change to a synced section sets `syncUpdatedAt = Date.now()` and pushes; peer prefs (from `onPeerPrefs` or the `pushPrefs` reply) newer than `syncUpdatedAt` replace the synced sections (keeping local launch-state flags) and take the peer's stamp without pushing back.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/context/settings-sync.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { Settings } from "./settings"
import { mergePeerSections, syncableSections, syncKey } from "./settings-sync"

const settings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: false,
    followup: "steer",
    showFileTree: true,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: true,
    showReasoningSummaries: false,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    showCustomAgents: false,
    mobileTitlebarPosition: "top",
    newLayoutDesigns: true,
    layoutTransitionEligible: false,
    shouldDisplayTabsToast: true,
  },
  appearance: { fontSize: 14, mono: "", sans: "", terminal: "" },
  keybinds: { "file.attach": "mod+u" },
  permissions: { autoApprove: true },
  cleanup: { autoArchiveAfterPrClose: true },
  notifications: { agent: true, permissions: true, errors: false },
  sounds: {
    agentEnabled: true,
    agent: "a",
    permissionsEnabled: true,
    permissions: "b",
    errorsEnabled: false,
    errors: "c",
  },
  syncUpdatedAt: 5,
}

describe("syncableSections", () => {
  test("keeps the five synced sections and drops launch-state flags, permissions and cleanup", () => {
    const sections = syncableSections(settings)
    expect(Object.keys(sections).sort()).toEqual(["appearance", "general", "keybinds", "notifications", "sounds"])
    expect(sections.general).not.toHaveProperty("newLayoutDesigns")
    expect(sections.general).not.toHaveProperty("layoutTransitionEligible")
    expect(sections.general).not.toHaveProperty("shouldDisplayTabsToast")
    expect(sections.general).toHaveProperty("showTerminal", true)
  })
})

describe("syncKey", () => {
  test("ignores key order", () => {
    expect(syncKey({ a: { x: 1, y: 2 }, b: [1, { c: 3, d: 4 }] })).toBe(syncKey({ b: [1, { d: 4, c: 3 }], a: { y: 2, x: 1 } }))
  })
})

describe("mergePeerSections", () => {
  test("takes the peer's sections but keeps this install's launch-state flags", () => {
    const merged = mergePeerSections(settings, {
      updatedAt: 9,
      sections: {
        general: { ...syncableSections(settings).general as Record<string, unknown>, showTerminal: false, newLayoutDesigns: false },
        appearance: { fontSize: 18, mono: "Iosevka", sans: "", terminal: "" },
        keybinds: {},
      },
    })
    expect(merged.general?.showTerminal).toBe(false)
    expect(merged.general?.newLayoutDesigns).toBe(true)
    expect(merged.general?.shouldDisplayTabsToast).toBe(true)
    expect(merged.appearance?.fontSize).toBe(18)
    expect(merged.keybinds).toEqual({})
    expect(merged.sounds).toBeUndefined()
  })
})

describe("settings provider wiring", () => {
  test("pushes stamped prefs and applies peer prefs through the platform", () => {
    const source = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8")
    expect(source).toContain("machineSync.pushPrefs(")
    expect(source).toContain("machineSync.onPeerPrefs(")
    expect(source).toContain('setStore("syncUpdatedAt"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/context/settings-sync.test.ts`
Expected: FAIL — `Cannot find module './settings-sync'`.

- [ ] **Step 3: Add the platform capability**

In `packages/app/src/context/platform.tsx` add `import type { MachineSyncPlatform } from "./machine-sync-types"` after the `PluginManagerPlatform` import, and inside `PlatformBase` after `plugins?: PluginManagerPlatform`:

```ts

  /** Machine sync with one paired Flynncode computer (desktop only) */
  machineSync?: MachineSyncPlatform
```

- [ ] **Step 4: Implement the pure helpers**

Create `packages/app/src/context/settings-sync.ts`:

```ts
import type { MachineSyncPrefs } from "./machine-sync-types"
import type { Settings } from "./settings"

export const SYNCED_SECTIONS = ["general", "appearance", "keybinds", "notifications", "sounds"] as const
export type SyncedSection = (typeof SYNCED_SECTIONS)[number]

// These `general` fields record this install's upgrade history, not a
// preference, so they never travel between machines.
export const LOCAL_GENERAL_KEYS = [
  "newLayoutDesigns",
  "layoutTransitionEligible",
  "agentVisibilityInitialized",
  "newInterfaceNoticeDismissed",
  "shouldDisplayTabsToast",
] as const

export function syncableSections(settings: Settings): Record<string, unknown> {
  return Object.fromEntries(
    SYNCED_SECTIONS.flatMap((section) => {
      const value: unknown = settings[section]
      if (!isRecord(value)) return []
      if (section !== "general") return [[section, value]]
      return [[section, Object.fromEntries(Object.entries(value).filter(([key]) => !isLocalGeneralKey(key)))]]
    }),
  )
}

export function syncKey(sections: Record<string, unknown>) {
  return stableStringify(sections)
}

export function mergePeerSections(current: Settings, peer: MachineSyncPrefs): Partial<Pick<Settings, SyncedSection>> {
  const local: unknown = current.general
  const kept = isRecord(local) ? Object.fromEntries(Object.entries(local).filter(([key]) => isLocalGeneralKey(key))) : {}
  const entries = SYNCED_SECTIONS.flatMap((section) => {
    const incoming = peer.sections[section]
    if (!isRecord(incoming)) return []
    if (section !== "general") return [[section, incoming] as const]
    const shared = Object.fromEntries(Object.entries(incoming).filter(([key]) => !isLocalGeneralKey(key)))
    return [[section, { ...shared, ...kept }] as const]
  })
  // Peer prefs come from the same Flynncode version (the worker stops on a
  // version mismatch before it pulls prefs), so section shapes match ours.
  return Object.fromEntries(entries) as Partial<Pick<Settings, SyncedSection>>
}

function isLocalGeneralKey(key: string) {
  return (LOCAL_GENERAL_KEYS as readonly string[]).includes(key)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
```

- [ ] **Step 5: Stamp, push and apply in the settings provider**

In `packages/app/src/context/settings.tsx`:

1. Change the first two imports and add two:

```ts
import { createStore, reconcile, unwrap } from "solid-js/store"
import { batch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { MachineSyncPrefs } from "./machine-sync-types"
import { mergePeerSections, syncableSections, syncKey } from "./settings-sync"
```

2. In `interface Settings` add after `sounds: SoundSettings`:

```ts
  /** Machine sync: when the synced sections last changed (newest wins). */
  syncUpdatedAt?: number
```

3. After the `createEffect` that resets `followup` from `"queue"` (just before `return {`), add:

```ts
    const machineSync = platform.machineSync
    if (machineSync) {
      const sync = { previous: undefined as string | undefined }
      const applyPeer = (prefs: MachineSyncPrefs) => {
        if (prefs.updatedAt <= (store.syncUpdatedAt ?? 0)) return
        const merged = mergePeerSections(store, prefs)
        // Record the post-apply snapshot first so the change effect below sees
        // no local edit and does not push the peer's prefs straight back.
        sync.previous = syncKey(syncableSections({ ...unwrap(store), ...merged }))
        batch(() => {
          if (merged.general) setStore("general", reconcile(merged.general))
          if (merged.appearance) setStore("appearance", reconcile(merged.appearance))
          if (merged.keybinds) setStore("keybinds", reconcile(merged.keybinds))
          if (merged.notifications) setStore("notifications", reconcile(merged.notifications))
          if (merged.sounds) setStore("sounds", reconcile(merged.sounds))
          setStore("syncUpdatedAt", prefs.updatedAt)
        })
      }
      createEffect(() => {
        if (!ready()) return
        const sections = syncableSections(store)
        const key = syncKey(sections)
        if (key === sync.previous) return
        const first = sync.previous === undefined
        sync.previous = key
        const updatedAt = first ? untrack(() => store.syncUpdatedAt ?? 0) : Date.now()
        if (!first) setStore("syncUpdatedAt", updatedAt)
        void machineSync
          .pushPrefs({ sections, updatedAt })
          .then((newer) => {
            if (newer) applyPeer(newer)
          })
          .catch(() => undefined)
      })
      onCleanup(machineSync.onPeerPrefs(applyPeer))
    }
```

- [ ] **Step 6: Expose the API on the desktop platform**

In `packages/desktop/src/renderer/index.tsx`, in the returned platform object, add after the `plugins: { … },` entry:

```ts
    machineSync: window.api.machineSync,
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/context/settings-sync.test.ts src/context/settings.test.ts`
Expected: PASS (if `src/context/settings.test.ts` does not exist, run only the new file).

- [ ] **Step 8: Typecheck**

Run: `cd packages/app && bun typecheck` then `cd packages/desktop && bun typecheck`
Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/context/platform.tsx packages/app/src/context/settings-sync.ts packages/app/src/context/settings-sync.test.ts packages/app/src/context/settings.tsx packages/desktop/src/renderer/index.tsx
git commit -m "$(cat <<'EOF'
feat(app): sync app preferences with the paired machine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Sync card in Settings → Servers, and the folder-missing notice

**Files:**
- Create: `packages/app/src/components/settings-v2/sync-card-status.ts`
- Create: `packages/app/src/components/settings-v2/sync-card.tsx`
- Modify: `packages/app/src/components/settings-v2/servers.tsx` (import line 15; render after `<PhoneCard />`, line 89)
- Modify: `packages/app/src/components/prompt-input-v2.tsx` (solid-js import line 12; `PromptInputV2Composer` body lines 56-85)
- Modify: `packages/app/src/i18n/en.ts` (after `"server.phone.relay.token.saved"`, line 509)
- Modify: `packages/app/src/i18n/flynncode-fallback.ts` (sorted `keys` list, after `"server.phone.title"`)
- Test: `packages/app/src/components/settings-v2/sync-card-status.test.ts`; modify `packages/app/src/components/prompt-input-v2.test.ts`

**Interfaces:**
- Consumes: `usePlatform().machineSync` (`MachineSyncPlatform`, Task 9/10), `MachineSyncStatus`, `MachineSyncPairingCode`, `MachineSyncPairResult`, `useLanguage().t`, `showToast` (`@/utils/toast`), `ButtonV2`, `TextInputV2`, `SettingsListV2`.
- Produces:
  - `syncHeadline(status: MachineSyncStatus): { key: "server.sync.unpaired" } | { key: "server.sync.online" | "server.sync.offline" | "server.sync.paused"; name: string }`
  - `syncProblem(status: MachineSyncStatus): { key: "server.sync.error.mismatch" } | { key: "server.sync.error.unauthorized" } | { key: "server.sync.error.failures"; count: number } | { key: "server.sync.error.other"; error: string } | undefined`
  - `syncNowFailed(status: MachineSyncStatus): boolean`
  - `SyncCard: Component` rendered under the Phone card.
  - i18n keys `server.sync.*` (listed in Step 4).

- [ ] **Step 1: Write the failing tests**

Create `packages/app/src/components/settings-v2/sync-card-status.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { MachineSyncStatus } from "@/context/machine-sync-types"
import { dict } from "@/i18n/en"
import { flynncodeFallback } from "@/i18n/flynncode-fallback"
import { syncHeadline, syncNowFailed, syncProblem } from "./sync-card-status"

const status: MachineSyncStatus = {
  paired: true,
  peerName: "starship",
  paused: false,
  phase: "idle",
  online: true,
  lastSuccess: 1,
  received: 2,
  sent: 1,
  missingDirectories: [],
  backlog: null,
  failures: [],
  lastError: null,
  machineName: "challenger",
  addresses: ["192.168.1.10"],
}

describe("syncHeadline", () => {
  test("names the peer and its state", () => {
    expect(syncHeadline(status)).toEqual({ key: "server.sync.online", name: "starship" })
    expect(syncHeadline({ ...status, online: false })).toEqual({ key: "server.sync.offline", name: "starship" })
    expect(syncHeadline({ ...status, paused: true })).toEqual({ key: "server.sync.paused", name: "starship" })
    expect(syncHeadline({ ...status, paired: false, peerName: null })).toEqual({ key: "server.sync.unpaired" })
  })
})

describe("syncProblem", () => {
  test("maps mismatch, 401, failures and other errors to copy", () => {
    expect(syncProblem(status)).toBeUndefined()
    expect(syncProblem({ ...status, phase: "mismatch" })).toEqual({ key: "server.sync.error.mismatch" })
    expect(syncProblem({ ...status, phase: "unauthorized" })).toEqual({ key: "server.sync.error.unauthorized" })
    expect(syncProblem({ ...status, failures: [{ id: "ses_a", error: "422" }] })).toEqual({
      key: "server.sync.error.failures",
      count: 1,
    })
    expect(syncProblem({ ...status, lastError: "settings: 422" })).toEqual({
      key: "server.sync.error.other",
      error: "settings: 422",
    })
  })
})

describe("syncNowFailed", () => {
  test("only a clean idle cycle counts as success", () => {
    expect(syncNowFailed(status)).toBe(false)
    expect(syncNowFailed({ ...status, phase: "offline" })).toBe(true)
    expect(syncNowFailed({ ...status, failures: [{ id: "ses_a", error: "x" }] })).toBe(true)
  })
})

describe("sync copy", () => {
  test("every sync key exists in English and in the Flynncode fallback", () => {
    const keys = Object.keys(dict).filter((key) => key.startsWith("server.sync."))
    expect(keys.length).toBe(31)
    expect(dict["server.sync.error.mismatch"]).toBe("Update Flynncode on both machines")
    expect(dict["server.sync.error.unauthorized"]).toBe("Pair again")
    for (const key of keys) expect(Object.hasOwn(flynncodeFallback, key), key).toBe(true)
  })

  test("the card uses the platform API and i18n only", () => {
    const source = readFileSync(new URL("./sync-card.tsx", import.meta.url), "utf8")
    expect(source).toContain("usePlatform().machineSync")
    expect(source).not.toContain("window.api")
    expect(source.match(/>\s*[A-Z][a-z]+[^<{]*</g) ?? []).toEqual([])
    const servers = readFileSync(new URL("./servers.tsx", import.meta.url), "utf8")
    expect(servers).toContain("<SyncCard />")
  })
})
```

Append to `packages/app/src/components/prompt-input-v2.test.ts`:

```ts
describe("PromptInputV2Composer machine sync notice", () => {
  test("warns when the session folder is missing on this machine", () => {
    expect(source).toContain('language.t("server.sync.folderMissing")')
    expect(source).toContain("missingDirectories.includes(")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/components/settings-v2/sync-card-status.test.ts src/components/prompt-input-v2.test.ts`
Expected: FAIL — `Cannot find module './sync-card-status'` and the new prompt-input assertion fails.

- [ ] **Step 3: Implement the status helpers**

Create `packages/app/src/components/settings-v2/sync-card-status.ts`:

```ts
import type { MachineSyncStatus } from "@/context/machine-sync-types"

export function syncHeadline(status: MachineSyncStatus) {
  if (!status.paired || status.peerName === null) return { key: "server.sync.unpaired" as const }
  if (status.paused) return { key: "server.sync.paused" as const, name: status.peerName }
  return { key: status.online ? ("server.sync.online" as const) : ("server.sync.offline" as const), name: status.peerName }
}

export function syncProblem(status: MachineSyncStatus) {
  if (status.phase === "mismatch") return { key: "server.sync.error.mismatch" as const }
  if (status.phase === "unauthorized") return { key: "server.sync.error.unauthorized" as const }
  if (status.failures.length > 0) return { key: "server.sync.error.failures" as const, count: status.failures.length }
  if (status.lastError) return { key: "server.sync.error.other" as const, error: status.lastError }
  return undefined
}

// Background cycles stay silent; only a manual Sync now that did not finish
// cleanly shows a toast.
export function syncNowFailed(status: MachineSyncStatus) {
  return status.phase !== "idle" || status.failures.length > 0 || status.lastError !== null
}
```

- [ ] **Step 4: Add the copy**

In `packages/app/src/i18n/en.ts` insert after `"server.phone.relay.token.saved": …,`:

```ts
  "server.sync.title": "Machine sync",
  "server.sync.unpaired": "Not paired. Pair with your other Flynncode computer on this network.",
  "server.sync.online": "{{name}} · online",
  "server.sync.offline": "{{name}} · offline",
  "server.sync.paused": "{{name}} · paused",
  "server.sync.lastSync": "Last synced {{time}}",
  "server.sync.never": "Not synced yet",
  "server.sync.counts": "Last cycle: {{received}} received, {{sent}} sent",
  "server.sync.missing": "Folders missing on this machine: {{count}}",
  "server.sync.progress": "First sync: {{done}} of {{total}} chats",
  "server.sync.error.mismatch": "Update Flynncode on both machines",
  "server.sync.error.unauthorized": "Pair again",
  "server.sync.error.failures": "{{count}} chats could not be applied and will retry next cycle",
  "server.sync.error.other": "Last error: {{error}}",
  "server.sync.code.show": "Show pairing code",
  "server.sync.code.value": "Pairing code: {{code}}",
  "server.sync.code.hint": "Enter this code on the other computer within 10 minutes. This computer: {{name}} ({{addresses}})",
  "server.sync.host.label": "Other computer",
  "server.sync.host.placeholder": "starship.local or 192.168.1.20",
  "server.sync.pairCode.label": "Pairing code",
  "server.sync.pairCode.placeholder": "6-digit code",
  "server.sync.pair": "Pair",
  "server.sync.pairFailed.unreachable": "Could not reach that computer.",
  "server.sync.pairFailed.invalid-code": "That code is wrong or expired.",
  "server.sync.pairFailed.failed": "Pairing failed.",
  "server.sync.syncNow": "Sync now",
  "server.sync.pause": "Pause",
  "server.sync.resume": "Resume",
  "server.sync.unpair": "Unpair",
  "server.sync.toast.failed": "Sync failed",
  "server.sync.folderMissing": "Folder missing on this machine",
```

In `packages/app/src/i18n/flynncode-fallback.ts` insert after `"server.phone.title",` (keeping the list sorted):

```ts
  "server.sync.code.hint",
  "server.sync.code.show",
  "server.sync.code.value",
  "server.sync.counts",
  "server.sync.error.failures",
  "server.sync.error.mismatch",
  "server.sync.error.other",
  "server.sync.error.unauthorized",
  "server.sync.folderMissing",
  "server.sync.host.label",
  "server.sync.host.placeholder",
  "server.sync.lastSync",
  "server.sync.missing",
  "server.sync.never",
  "server.sync.offline",
  "server.sync.online",
  "server.sync.pair",
  "server.sync.pairCode.label",
  "server.sync.pairCode.placeholder",
  "server.sync.pairFailed.failed",
  "server.sync.pairFailed.invalid-code",
  "server.sync.pairFailed.unreachable",
  "server.sync.pause",
  "server.sync.paused",
  "server.sync.progress",
  "server.sync.resume",
  "server.sync.syncNow",
  "server.sync.title",
  "server.sync.toast.failed",
  "server.sync.unpair",
  "server.sync.unpaired",
```

- [ ] **Step 5: Build the Sync card**

Create `packages/app/src/components/settings-v2/sync-card.tsx`:

```tsx
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { MachineSyncPairingCode, MachineSyncStatus } from "@/context/machine-sync-types"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { syncHeadline, syncNowFailed, syncProblem } from "./sync-card-status"

const PAIR_FAILURE_KEYS = {
  unreachable: "server.sync.pairFailed.unreachable",
  "invalid-code": "server.sync.pairFailed.invalid-code",
  failed: "server.sync.pairFailed.failed",
} as const

export const SyncCard: Component = () => {
  const language = useLanguage()
  const api = usePlatform().machineSync
  const [state, setState] = createStore({
    status: undefined as MachineSyncStatus | undefined,
    code: undefined as MachineSyncPairingCode | undefined,
    host: "",
    pairCode: "",
    pairFailure: undefined as keyof typeof PAIR_FAILURE_KEYS | undefined,
    pairing: false,
  })

  onMount(() => {
    if (!api) return
    void api
      .status()
      .then((status) => setState("status", status))
      .catch(() => undefined)
    onCleanup(api.subscribe((status) => setState("status", status)))
  })

  const showCode = () => {
    void api
      ?.createPairingCode()
      .then((code) => setState("code", code))
      .catch(() => undefined)
  }
  const pair = () => {
    const host = state.host.trim()
    const code = state.pairCode.trim()
    if (!api || !host || !code) return
    setState({ pairing: true, pairFailure: undefined })
    void api.pair({ host, code }).then((result) => {
      if (result.ok) {
        setState({ pairing: false, host: "", pairCode: "", code: undefined })
        return
      }
      setState({ pairing: false, pairFailure: result.reason })
    })
  }
  const syncNow = () => {
    void api?.syncNow().then((status) => {
      setState("status", status)
      if (syncNowFailed(status)) showToast({ variant: "error", description: language.t("server.sync.toast.failed") })
    })
  }
  const togglePause = () => {
    void api?.setPaused(!state.status?.paused)
  }
  const unpair = () => {
    void api?.unpair()
  }

  const headline = (status: MachineSyncStatus) => {
    const line = syncHeadline(status)
    if (line.key === "server.sync.unpaired") return language.t(line.key)
    return language.t(line.key, { name: line.name })
  }
  const problem = (status: MachineSyncStatus) => {
    const found = syncProblem(status)
    if (!found) return undefined
    if (found.key === "server.sync.error.failures") return language.t(found.key, { count: found.count })
    if (found.key === "server.sync.error.other") return language.t(found.key, { error: found.error })
    return language.t(found.key)
  }
  const lastSync = (status: MachineSyncStatus) =>
    status.lastSuccess === null
      ? language.t("server.sync.never")
      : language.t("server.sync.lastSync", { time: new Date(status.lastSuccess).toLocaleString() })

  return (
    <Show when={api && state.status}>
      {(status) => (
        <SettingsListV2>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <div
                aria-hidden="true"
                classList={{
                  "size-1.5 rounded-full shrink-0 my-[3.5px]": true,
                  "bg-icon-success-base": status().online,
                  "bg-border-weak-base": !status().online,
                }}
              />
              <div class="settings-v2-servers-copy">
                <span class="settings-v2-servers-name">{language.t("server.sync.title")}</span>
                <span class="settings-v2-servers-meta">{headline(status())}</span>
              </div>
            </div>
          </div>
          <Show
            when={status().paired}
            fallback={
              <>
                <div class="settings-v2-servers-row">
                  <div class="settings-v2-servers-lead">
                    <div class="settings-v2-servers-copy">
                      <Show when={state.code}>
                        {(code) => (
                          <>
                            <span class="settings-v2-servers-name font-mono select-all">
                              {language.t("server.sync.code.value", { code: code().code })}
                            </span>
                            <span class="settings-v2-servers-meta">
                              {language.t("server.sync.code.hint", {
                                name: code().machineName,
                                addresses: code().addresses.join(", "),
                              })}
                            </span>
                          </>
                        )}
                      </Show>
                    </div>
                  </div>
                  <div class="settings-v2-servers-actions">
                    <ButtonV2 size="small" variant="ghost-muted" onClick={showCode}>
                      {language.t("server.sync.code.show")}
                    </ButtonV2>
                  </div>
                </div>
                <div class="settings-v2-servers-row">
                  <div class="settings-v2-servers-lead">
                    <TextInputV2
                      appearance="base"
                      value={state.host}
                      onInput={(event) => setState("host", event.currentTarget.value)}
                      placeholder={language.t("server.sync.host.placeholder")}
                      spellcheck={false}
                      autocorrect="off"
                      autocomplete="off"
                      autocapitalize="off"
                      aria-label={language.t("server.sync.host.label")}
                    />
                    <TextInputV2
                      appearance="base"
                      value={state.pairCode}
                      onInput={(event) => setState("pairCode", event.currentTarget.value)}
                      placeholder={language.t("server.sync.pairCode.placeholder")}
                      inputMode="numeric"
                      autocomplete="off"
                      aria-label={language.t("server.sync.pairCode.label")}
                    />
                  </div>
                  <div class="settings-v2-servers-actions">
                    <ButtonV2 size="small" variant="ghost-muted" disabled={state.pairing} onClick={pair}>
                      {language.t("server.sync.pair")}
                    </ButtonV2>
                  </div>
                </div>
                <Show when={state.pairFailure}>
                  {(failure) => (
                    <div class="settings-v2-servers-row">
                      <span class="settings-v2-servers-meta">{language.t(PAIR_FAILURE_KEYS[failure()])}</span>
                    </div>
                  )}
                </Show>
              </>
            }
          >
            <div class="settings-v2-servers-row">
              <div class="settings-v2-servers-lead">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-name">{lastSync(status())}</span>
                  <span class="settings-v2-servers-meta">
                    {language.t("server.sync.counts", { received: status().received, sent: status().sent })}
                  </span>
                </div>
              </div>
              <div class="settings-v2-servers-actions">
                <ButtonV2 size="small" variant="ghost-muted" disabled={status().paused} onClick={syncNow}>
                  {language.t("server.sync.syncNow")}
                </ButtonV2>
                <ButtonV2 size="small" variant="ghost-muted" onClick={togglePause}>
                  {status().paused ? language.t("server.sync.resume") : language.t("server.sync.pause")}
                </ButtonV2>
                <ButtonV2 size="small" variant="ghost-muted" onClick={unpair}>
                  {language.t("server.sync.unpair")}
                </ButtonV2>
              </div>
            </div>
            <Show when={status().backlog}>
              {(backlog) => (
                <div class="settings-v2-servers-row">
                  <span class="settings-v2-servers-meta">
                    {language.t("server.sync.progress", { done: backlog().done, total: backlog().total })}
                  </span>
                </div>
              )}
            </Show>
            <Show when={status().missingDirectories.length > 0}>
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-meta">
                    {language.t("server.sync.missing", { count: status().missingDirectories.length })}
                  </span>
                  <For each={status().missingDirectories}>
                    {(directory) => <span class="settings-v2-servers-meta font-mono">{directory}</span>}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={problem(status())}>
              {(text) => (
                <div class="settings-v2-servers-row">
                  <span class="settings-v2-servers-meta">{text()}</span>
                </div>
              )}
            </Show>
          </Show>
        </SettingsListV2>
      )}
    </Show>
  )
}
```

- [ ] **Step 6: Render the card under the Phone card**

In `packages/app/src/components/settings-v2/servers.tsx` add `import { SyncCard } from "./sync-card"` after the `PhoneCard` import, and change line 89 to:

```tsx
        <PhoneCard />
        <SyncCard />
```

- [ ] **Step 7: Show the folder-missing notice in the composer**

In `packages/app/src/components/prompt-input-v2.tsx`:

1. Change line 12 to `import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"` and add `import type { MachineSyncStatus } from "@/context/machine-sync-types"` next to the other `@/context` imports.

2. In `PromptInputV2Composer`, after `const queryOptions = useQueryOptions()` add:

```ts
  const platform = usePlatform()
  const [syncStatus, setSyncStatus] = createSignal<MachineSyncStatus>()
  onMount(() => {
    const api = platform.machineSync
    if (!api) return
    void api
      .status()
      .then((status) => setSyncStatus(status))
      .catch(() => undefined)
    onCleanup(api.subscribe((status) => setSyncStatus(status)))
  })
  // A chat synced from the other machine may point at a folder that does not
  // exist here; it stays readable, but tools would fail in it.
  const folderMissing = createMemo(() => {
    const directory = sdk().directory
    return !!directory && (syncStatus()?.missingDirectories.includes(directory) ?? false)
  })
```

3. In its JSX, directly inside `<div class="flex flex-col gap-3">` and before `<PromptInputV2`, add:

```tsx
      <Show when={folderMissing()}>
        <span class="text-12-regular text-text-weak px-1" data-slot="sync-folder-missing">
          {language.t("server.sync.folderMissing")}
        </span>
      </Show>
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/components/settings-v2/sync-card-status.test.ts src/components/prompt-input-v2.test.ts src/i18n/parity.test.ts`
Expected: PASS (parity stays green because every new key is in the fallback list that every locale spreads).

- [ ] **Step 9: Typecheck**

Run: `cd packages/app && bun typecheck`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git add packages/app/src/components/settings-v2/sync-card-status.ts packages/app/src/components/settings-v2/sync-card-status.test.ts packages/app/src/components/settings-v2/sync-card.tsx packages/app/src/components/settings-v2/servers.tsx packages/app/src/components/prompt-input-v2.tsx packages/app/src/components/prompt-input-v2.test.ts packages/app/src/i18n/en.ts packages/app/src/i18n/flynncode-fallback.ts
git commit -m "$(cat <<'EOF'
feat(app): add the machine sync card to server settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: "Phone access" switch on the Phone card

**Files:**
- Modify: `packages/app/src/components/settings-v2/phone-card.tsx` (imports lines 1-8; `PhoneApi` lines 19-23; component state after `rotatePhonePassword` ~line 67; the `return (…)` JSX lines 136-378)
- Modify: `packages/app/src/i18n/en.ts` (after `"server.phone.title": "Phone",`, line 486)
- Modify: `packages/app/src/i18n/flynncode-fallback.ts` (before `"server.phone.away.direct",`)
- Test: `packages/app/src/components/settings-v2/phone-card.test.tsx`

**Interfaces:**
- Consumes: `window.api.getPhoneAccess(): Promise<boolean>`, `window.api.setPhoneAccess(enabled: boolean): Promise<void>` (Task 9; main persists `phoneAccess` and pushes `sync-config`, the sidecar starts/stops phone routes live — Task 8), `Switch` from `@opencode-ai/ui/v2/switch-v2`.
- Produces: keys `server.phone.access.label`, `server.phone.access.hint`, `server.phone.access.off`; the switch is OFF until the user turns it on; with it off the card hides URLs, QR codes, password and relay rows and shows the "off" hint; toggling refetches gateway status (no restart).

- [ ] **Step 1: Write the failing test**

In `packages/app/src/components/settings-v2/phone-card.test.tsx` add `import { readFileSync } from "node:fs"` below the `bun:test` import and append inside `describe("phone launcher url", …)`:

```ts
  test("phone access switch is wired, defaults off and its copy is in the fallback", async () => {
    const { dict } = (await import("@/i18n/en")) as Record<string, Record<string, string>>
    expect(dict["server.phone.access.label"]).toBe("Phone access")
    expect(dict["server.phone.access.hint"]).toContain("right away")
    expect(dict["server.phone.access.off"]).toContain("off")
    const { flynncodeFallback } = await import("@/i18n/flynncode-fallback")
    for (const key of ["server.phone.access.hint", "server.phone.access.label", "server.phone.access.off"])
      expect(Object.hasOwn(flynncodeFallback, key), key).toBe(true)
    const source = readFileSync(new URL("./phone-card.tsx", import.meta.url), "utf8")
    expect(source).toContain("createSignal(false)")
    expect(source).toContain("setPhoneAccess?.(")
    expect(source).toContain('language.t("server.phone.access.label")')
    expect(source).toContain("<Show when={phoneAccess()}>")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/components/settings-v2/phone-card.test.tsx`
Expected: FAIL — `expect(received).toBe(expected)` for `dict["server.phone.access.label"]` (undefined).

- [ ] **Step 3: Add the copy**

In `packages/app/src/i18n/en.ts` after `"server.phone.title": "Phone",` insert:

```ts
  "server.phone.access.label": "Phone access",
  "server.phone.access.hint": "Let your phone open chats on this computer over Wi-Fi. Changes apply right away.",
  "server.phone.access.off": "Phone access is off. Machine sync keeps working.",
```

In `packages/app/src/i18n/flynncode-fallback.ts` insert before `"server.phone.away.direct",`:

```ts
  "server.phone.access.hint",
  "server.phone.access.label",
  "server.phone.access.off",
```

- [ ] **Step 4: Add the switch**

In `packages/app/src/components/settings-v2/phone-card.tsx`:

1. Add `import { Switch } from "@opencode-ai/ui/v2/switch-v2"` after the `TextInputV2` import.

2. Extend `PhoneApi`:

```ts
type PhoneApi = {
  getMobileGatewayStatus?: () => Promise<MobileGatewayStatus>
  getMobilePhonePassword?: () => Promise<string | null>
  rotateMobilePhonePassword?: () => Promise<string>
  getPhoneAccess?: () => Promise<boolean>
  setPhoneAccess?: (enabled: boolean) => Promise<void>
}
```

3. After the `rotatePhonePassword` arrow function add:

```ts
  // Off by default: the gateway answers 404 on every phone route until the
  // user turns this on. The sidecar applies the change live.
  const [phoneAccess, setPhoneAccess] = createSignal(false)
  onMount(() => {
    void phoneApi
      ?.getPhoneAccess?.()
      .then((enabled) => setPhoneAccess(enabled))
      .catch(() => undefined)
  })
  const togglePhoneAccess = (enabled: boolean) => {
    setPhoneAccess(enabled)
    void phoneApi
      ?.setPhoneAccess?.(enabled)
      .then(() => [500, 1500, 3000].forEach((delay) => setTimeout(() => refetch(), delay)))
      .catch(() => setPhoneAccess(!enabled))
  }
```

4. Replace the whole `return ( … )` of `PhoneCard` with:

```tsx
  return (
    <Show when={available && current()}>
      <SettingsListV2>
        <div class="settings-v2-servers-row">
          <div class="settings-v2-servers-lead">
            <div
              aria-hidden="true"
              classList={{
                "size-1.5 rounded-full shrink-0 my-[3.5px]": true,
                "bg-icon-success-base": phoneAccess() && gatewayRunning(),
                "bg-border-weak-base": !(phoneAccess() && gatewayRunning()),
              }}
            />
            <div class="settings-v2-servers-copy">
              <span class="settings-v2-servers-name">{language.t("server.phone.title")}</span>
              <span class="settings-v2-servers-meta">
                <Show when={phoneAccess()} fallback={language.t("server.phone.access.off")}>
                  <Show when={gatewayRunning()} fallback={language.t("server.phone.stopped")}>
                    <Show when={hasUrls()} fallback={language.t("server.phone.noWifi")}>
                      {language.t("server.phone.hint")}
                    </Show>
                  </Show>
                </Show>
              </span>
            </div>
          </div>
        </div>
        <div class="settings-v2-servers-row">
          <div class="settings-v2-servers-lead">
            <div class="settings-v2-servers-copy">
              <span class="settings-v2-servers-name">{language.t("server.phone.access.label")}</span>
              <span class="settings-v2-servers-meta">{language.t("server.phone.access.hint")}</span>
            </div>
          </div>
          <div class="settings-v2-servers-actions">
            <Switch checked={phoneAccess()} onChange={togglePhoneAccess} hideLabel>
              {language.t("server.phone.access.label")}
            </Switch>
          </div>
        </div>
        <Show when={phoneAccess()}>
          <Show when={gatewayRunning() && hasUrls()}>
            <For each={launcherUrls()}>
              {(url) => (
                <div class="settings-v2-servers-row">
                  <div class="settings-v2-servers-lead">
                    <div class="settings-v2-servers-copy">
                      <span class="settings-v2-servers-name">{url}</span>
                    </div>
                  </div>
                  <div class="settings-v2-servers-actions">
                    <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(url)}>
                      <Show when={copied() === url} fallback={language.t("server.phone.copy")}>
                        {language.t("session.share.copy.copied")}
                      </Show>
                    </ButtonV2>
                  </div>
                </div>
              )}
            </For>
            <Show when={qrUrl()}>
              <div class="settings-v2-servers-row">
                <canvas
                  ref={(element) => {
                    qrCanvas = element
                  }}
                  aria-label={language.t("server.phone.title")}
                  style={{ width: "128px", height: "128px", "image-rendering": "pixelated" }}
                />
              </div>
            </Show>
          </Show>
          <Show when={gatewayRunning() && !hasUrls()}>
            <div class="settings-v2-servers-row">
              <div class="settings-v2-servers-lead">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-name">{loopbackUrl()}</span>
                </div>
              </div>
              <div class="settings-v2-servers-actions">
                <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(loopbackUrl())}>
                  <Show when={copied() === loopbackUrl()} fallback={language.t("server.phone.copy")}>
                    {language.t("session.share.copy.copied")}
                  </Show>
                </ButtonV2>
              </div>
            </div>
          </Show>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <div class="settings-v2-servers-copy">
                <span class="settings-v2-servers-name">{language.t("server.phone.password.label")}</span>
                <span class="settings-v2-servers-meta">
                  <Show when={phonePassword.value} fallback={language.t("server.phone.password.unavailable")}>
                    {language.t("server.phone.password.hint")}
                  </Show>
                </span>
              </div>
            </div>
          </div>
          <Show when={phonePassword.value}>
            {(password) => (
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-lead">
                  <div class="settings-v2-servers-copy">
                    <span class="settings-v2-servers-name font-mono select-all">
                      {phonePassword.visible ? password() : MASKED_PASSWORD}
                    </span>
                  </div>
                </div>
                <div class="settings-v2-servers-actions">
                  <ButtonV2
                    size="small"
                    variant="ghost-muted"
                    onClick={() => setPhonePassword("visible", (visible) => !visible)}
                  >
                    {phonePassword.visible
                      ? language.t("server.phone.password.hide")
                      : language.t("server.phone.password.show")}
                  </ButtonV2>
                  <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(password())}>
                    <Show when={copied() === password()} fallback={language.t("server.phone.copy")}>
                      {language.t("session.share.copy.copied")}
                    </Show>
                  </ButtonV2>
                  <ButtonV2 size="small" variant="ghost-muted" onClick={rotatePhonePassword}>
                    {language.t("server.phone.password.rotate")}
                  </ButtonV2>
                </div>
              </div>
            )}
          </Show>
          <Show when={phonePassword.rotated}>
            <div class="settings-v2-servers-row">
              <div class="settings-v2-servers-lead">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-meta">{language.t("server.phone.password.rotated")}</span>
                </div>
              </div>
            </div>
          </Show>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <div class="settings-v2-servers-copy">
                <span class="settings-v2-servers-name">{language.t("server.phone.away.title")}</span>
                <span class="settings-v2-servers-meta">{language.t("server.phone.away.direct")}</span>
              </div>
            </div>
          </div>
          <Show
            when={tailnetUrl()}
            fallback={
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-lead">
                  <div class="settings-v2-servers-copy">
                    <span class="settings-v2-servers-meta">{language.t("server.phone.noWifi")}</span>
                  </div>
                </div>
              </div>
            }
          >
            {(url) => (
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-lead">
                  <div class="settings-v2-servers-copy">
                    <span class="settings-v2-servers-name">{url()}</span>
                  </div>
                </div>
                <div class="settings-v2-servers-actions">
                  <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(url())}>
                    <Show when={copied() === url()} fallback={language.t("server.phone.copy")}>
                      {language.t("session.share.copy.copied")}
                    </Show>
                  </ButtonV2>
                </div>
              </div>
            )}
          </Show>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <div class="settings-v2-servers-copy">
                <span class="settings-v2-servers-name">{language.t("server.phone.relay.title")}</span>
                <span class="settings-v2-servers-meta">{language.t("server.phone.relay.hint")}</span>
              </div>
            </div>
          </div>
          <Show
            when={relayLauncherUrl()}
            fallback={
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-lead">
                  <div class="settings-v2-servers-copy">
                    <span class="settings-v2-servers-meta">{language.t("server.phone.relay.stopped")}</span>
                  </div>
                </div>
              </div>
            }
          >
            {(url) => (
              <>
                <div class="settings-v2-servers-row">
                  <div class="settings-v2-servers-lead">
                    <div class="settings-v2-servers-copy">
                      <span class="settings-v2-servers-name">{url()}</span>
                    </div>
                  </div>
                  <div class="settings-v2-servers-actions">
                    <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(url())}>
                      <Show when={copied() === url()} fallback={language.t("server.phone.copy")}>
                        {language.t("session.share.copy.copied")}
                      </Show>
                    </ButtonV2>
                  </div>
                </div>
                <Show when={relayQrUrl()}>
                  <div class="settings-v2-servers-row">
                    <canvas
                      ref={(element) => {
                        qrCanvasRelay = element
                      }}
                      aria-label={language.t("server.phone.relay.title")}
                      style={{ width: "128px", height: "128px", "image-rendering": "pixelated" }}
                    />
                  </div>
                </Show>
              </>
            )}
          </Show>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <div class="settings-v2-servers-copy">
                <span class="settings-v2-servers-name">{language.t("server.phone.relay.token.label")}</span>
                <span class="settings-v2-servers-meta">{language.t("server.phone.relay.token.hint")}</span>
              </div>
            </div>
          </div>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <TextInputV2
                type="password"
                appearance="base"
                value={remoteToken()}
                onInput={(event) => setRemoteToken(event.currentTarget.value)}
                placeholder={language.t("server.phone.relay.token.placeholder")}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                aria-label={language.t("server.phone.relay.token.label")}
              />
            </div>
            <div class="settings-v2-servers-actions">
              <ButtonV2 size="small" variant="ghost-muted" onClick={saveRemoteToken}>
                {language.t("server.phone.relay.token.save")}
              </ButtonV2>
            </div>
          </div>
          <Show when={tokenSaved()}>
            <div class="settings-v2-servers-row">
              <div class="settings-v2-servers-lead">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-meta">{language.t("server.phone.relay.token.saved")}</span>
                </div>
              </div>
            </div>
          </Show>
        </Show>
      </SettingsListV2>
    </Show>
  )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/components/settings-v2/phone-card.test.tsx src/i18n/parity.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd packages/app && bun typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/components/settings-v2/phone-card.tsx packages/app/src/components/settings-v2/phone-card.test.tsx packages/app/src/i18n/en.ts packages/app/src/i18n/flynncode-fallback.ts
git commit -m "$(cat <<'EOF'
feat(app): add an opt-in phone access switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Two-server end-to-end sync test

**Files:**
- Test: `packages/mobile-gateway/test/sync-e2e.test.ts`

**Interfaces:**
- Consumes: the real opencode server (`bun run ./src/index.ts serve` in `packages/opencode`, Tasks 1-5 routes), `createGateway` + `createSyncGate` (Task 6), `pairWithPeer` (Task 6), `createSyncWorker` (Task 7), the legacy `POST /session/:sessionID/shell` route (marks a chat busy while the command runs).
- Produces: one end-to-end suite proving pairing, two-way chat sync, settings without secrets, prefs, a conflict, a delete, an archive and a running-chat skip.

- [ ] **Step 1: Write the test**

Create `packages/mobile-gateway/test/sync-e2e.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createGateway } from "../src/gateway.ts"
import type { Manifest } from "../src/sync-decide.ts"
import { createSyncGate, type SyncGate, type SyncPeer } from "../src/sync-gate.ts"
import { pairWithPeer } from "../src/sync-pair.ts"
import { createSyncWorker, type SyncWorker } from "../src/sync-worker.ts"

// Two real opencode servers with separate data/config dirs stand in for
// challenger and starship; gateways, gates and workers run in this process
// exactly as the desktop sidecar runs them.
const OPENCODE_DIR = path.resolve(import.meta.dir, "../../opencode")
const PASSWORD = "e2e-server-secret"
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`

type Machine = {
  root: string
  url: string
  child: ReturnType<typeof Bun.spawn>
  gate: SyncGate
  gateway: ReturnType<typeof Bun.serve>
  worker: SyncWorker
  paired: SyncPeer[]
}

const state = { shared: "", project: "", missing: "" }
const machines: Machine[] = []

async function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = probe.port
  probe.stop(true)
  return port
}

async function startServer(root: string) {
  const port = await freePort()
  const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("OPENCODE_")))
  const child = Bun.spawn(["bun", "run", "./src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: OPENCODE_DIR,
    env: {
      ...env,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_MODELS_PATH: path.join(OPENCODE_DIR, "test", "tool", "fixtures", "models-api.json"),
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const ready = await fetch(`${url}/flynncode-sync/manifest`, { headers: { authorization: AUTH } }).then(
      (response) => response.ok,
      () => false,
    )
    if (ready) return { url, child }
    await Bun.sleep(250)
  }
  child.kill()
  throw new Error(`opencode server in ${root} did not start`)
}

async function machine(name: string): Promise<Machine> {
  const root = await mkdtemp(path.join(tmpdir(), `flynncode-sync-${name}-`))
  const server = await startServer(root)
  const paired: SyncPeer[] = []
  const gate = createSyncGate({
    machineName: name,
    gatewayPort: 4097,
    phoneAccess: false,
    paused: false,
    peer: undefined,
    prefs: undefined,
    onPaired: (peer) => paired.push(peer),
  })
  const handle = createGateway({
    options: {
      host: "127.0.0.1",
      port: 0,
      upstream: server.url,
      username: "opencode",
      password: "phone",
      upstreamPassword: PASSWORD,
      relayToken: "",
    },
    sync: gate,
  })
  const gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, srv) => handle(request, srv.requestIP(request)?.address),
  })
  const worker = createSyncWorker({
    local: { url: server.url, authorization: AUTH },
    peer: () => gate.peer(),
    paused: () => gate.paused(),
    prefs: { get: () => gate.prefs(), apply: (prefs) => gate.update({ prefs }) },
    takeSent: () => gate.takeSent(),
    onStatus: () => undefined,
  })
  const result = { root, url: server.url, child: server.child, gate, gateway, worker, paired }
  machines.push(result)
  return result
}

function local(target: Machine, pathname: string, body?: unknown) {
  return fetch(`${target.url}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function manifest(target: Machine) {
  return (await (await local(target, "/flynncode-sync/manifest")).json()) as Manifest
}

async function title(target: Machine, id: string) {
  const response = await local(target, `/flynncode-sync/session/${id}`)
  if (!response.ok) return undefined
  return ((await response.json()) as { session: { title: string } }).session.title
}

function bundle(input: { id: string; title: string; timeUpdated: number; directory: string }) {
  return {
    version: 1,
    session: {
      id: input.id,
      project_id: "global",
      workspace_id: null,
      parent_id: null,
      slug: input.id,
      directory: input.directory,
      path: null,
      title: input.title,
      version: "e2e",
      share_url: null,
      summary_additions: null,
      summary_deletions: null,
      summary_files: null,
      summary_diffs: null,
      metadata: null,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      revert: null,
      permission: null,
      agent: null,
      kind: "code",
      model: null,
      time_created: 1,
      time_updated: input.timeUpdated,
      time_compacting: null,
      time_archived: null,
    },
    project: {
      id: "global",
      worktree: "/",
      vcs: null,
      name: null,
      icon_url: null,
      icon_url_override: null,
      icon_color: null,
      time_created: 1,
      time_updated: 1,
      time_initialized: null,
      sandboxes: [],
      commands: null,
    },
    messages: [],
    parts: [],
    todos: [],
    folders: [],
    inputs: [],
    sessionMessages: [],
    contextEpoch: null,
    eventSequence: null,
    events: [],
  }
}

async function seed(target: Machine, input: { id: string; title: string; timeUpdated: number; directory?: string }) {
  const response = await local(target, "/flynncode-sync/apply", bundle({ ...input, directory: input.directory ?? state.missing }))
  expect(response.status).toBe(200)
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const ids = (value: Manifest) => value.sessions.map((session) => session.id).sort()

beforeAll(async () => {
  state.shared = await mkdtemp(path.join(tmpdir(), "flynncode-sync-shared-"))
  // Projects live at identical paths on both machines.
  state.project = path.join(state.shared, "project")
  state.missing = path.join(state.shared, "missing-on-both")
  await mkdir(state.project, { recursive: true })
  await machine("challenger")
  await machine("starship")
}, 180_000)

afterAll(async () => {
  for (const target of machines) {
    target.gateway.stop(true)
    target.child.kill()
    await rm(target.root, { recursive: true, force: true })
  }
  await rm(state.shared, { recursive: true, force: true })
})

describe("machine sync end to end", () => {
  test("pairs with a code and a 256-bit token", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    challenger.gate.setPairingCode({ code: "482913", expiresAt: Date.now() + 600_000 })
    const result = await pairWithPeer({ host: `127.0.0.1:${challenger.gateway.port}`, code: "482913", name: "starship" })
    if (!result.ok) throw new Error(`pairing failed: ${result.reason}`)
    starship.gate.update({ peer: result.peer })
    expect(result.peer.name).toBe("challenger")
    expect(result.peer.token).toMatch(/^[0-9a-f]{64}$/)
    expect(challenger.paired).toEqual([{ name: "starship", url: "http://127.0.0.1:4097", token: result.peer.token }])
    // Both gateways share 127.0.0.1 here, so point challenger at starship's real port.
    challenger.gate.update({ peer: { ...result.peer, name: "starship", url: `http://127.0.0.1:${starship.gateway.port}` } })
  })

  test("syncs chats, settings without secrets, and prefs both ways", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    await seed(challenger, { id: "ses_e2e_a1", title: "a1", timeUpdated: 1000 })
    await seed(challenger, { id: "ses_e2e_a2", title: "a2", timeUpdated: 1000 })
    await seed(starship, { id: "ses_e2e_b1", title: "b1", timeUpdated: 1000 })
    const config = path.join(challenger.root, "config", "opencode", "opencode.jsonc")
    await Bun.write(config, `{\n  "model": "anthropic/claude-e2e",\n  "provider": { "anthropic": { "options": { "apiKey": "sk-challenger-secret" } } }\n}\n`)
    await utimes(config, new Date(), new Date())
    challenger.gate.update({ prefs: { sections: { appearance: { fontSize: 18 } }, updatedAt: 50 } })

    const pulled = await starship.worker.cycle()
    await challenger.worker.cycle()

    expect(pulled).toMatchObject({ phase: "idle", received: 2 })
    expect(ids(await manifest(starship))).toEqual(["ses_e2e_a1", "ses_e2e_a2", "ses_e2e_b1"])
    expect(ids(await manifest(challenger))).toEqual(["ses_e2e_a1", "ses_e2e_a2", "ses_e2e_b1"])
    const copied = await Bun.file(path.join(starship.root, "config", "opencode", "opencode.jsonc")).text()
    expect(copied).toContain("anthropic/claude-e2e")
    expect(copied).not.toContain("sk-challenger-secret")
    expect(starship.gate.prefs()).toEqual({ sections: { appearance: { fontSize: 18 } }, updatedAt: 50 })
  }, 60_000)

  test("the newest copy wins a conflict", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    await seed(challenger, { id: "ses_e2e_a1", title: "edited on challenger", timeUpdated: 2000 })
    await seed(starship, { id: "ses_e2e_a1", title: "edited on starship", timeUpdated: 3000 })
    await challenger.worker.cycle()
    await starship.worker.cycle()
    expect(await title(challenger, "ses_e2e_a1")).toBe("edited on starship")
    expect(await title(starship, "ses_e2e_a1")).toBe("edited on starship")
  }, 60_000)

  test("a delete propagates and is not pulled back", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    expect((await local(challenger, "/flynncode-sync/delete/ses_e2e_a2", { timeDeleted: Date.now() })).status).toBe(200)
    await starship.worker.cycle()
    await challenger.worker.cycle()
    expect(ids(await manifest(starship))).not.toContain("ses_e2e_a2")
    expect(ids(await manifest(challenger))).not.toContain("ses_e2e_a2")
    expect((await manifest(starship)).tombstones.map((tombstone) => tombstone.id)).toContain("ses_e2e_a2")
  }, 60_000)

  test("an archive propagates", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    expect((await local(starship, "/flynncode-sync/archive/ses_e2e_b1", { timeArchived: Date.now() })).status).toBe(200)
    await challenger.worker.cycle()
    const archived = (await manifest(challenger)).sessions.find((session) => session.id === "ses_e2e_b1")
    expect(archived?.timeArchived).toBeNumber()
  }, 60_000)

  test("a running chat is skipped until it finishes", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    await seed(challenger, { id: "ses_e2e_run", title: "run", timeUpdated: 1000, directory: state.project })
    await starship.worker.cycle()
    expect(await title(starship, "ses_e2e_run")).toBe("run")

    // A shell command marks the chat busy on starship for a few seconds.
    const running = fetch(`${starship.url}/session/ses_e2e_run/shell`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json", "x-opencode-directory": state.project },
      body: JSON.stringify({ agent: "build", model: { providerID: "test", modelID: "test" }, command: "sleep 4" }),
    })
    const busy = async () =>
      (await manifest(starship)).sessions.some((session) => session.id === "ses_e2e_run" && session.busy)
    await waitFor(busy, "the chat to run on starship")

    await seed(challenger, { id: "ses_e2e_run", title: "newer on challenger", timeUpdated: Date.now() + 60_000, directory: state.project })
    const skipped = await starship.worker.cycle()
    expect(skipped.skipped).toContainEqual({ id: "ses_e2e_run", reason: "local-busy" })
    expect(await title(starship, "ses_e2e_run")).not.toBe("newer on challenger")

    await running
    await waitFor(async () => !(await busy()), "the chat to finish on starship")
    await starship.worker.cycle()
    expect(await title(starship, "ses_e2e_run")).toBe("newer on challenger")
  }, 90_000)
})
```

- [ ] **Step 2: Run the test**

Run: `cd packages/mobile-gateway && bun test test/sync-e2e.test.ts --timeout 180000`
Expected: PASS (6 tests). It fails at the first step whose behaviour is broken; if the running-chat step times out waiting for `busy`, check that `POST /session/:id/shell` reached the server (the instance bootstraps `state.project` on first use, which can take several seconds) before changing any sync code.

- [ ] **Step 3: Run every touched package's suite and typecheck**

Run each from its package directory:
- `cd packages/core && bun test test/session-tombstone.test.ts test/session-projector.test.ts test/database-migration.test.ts && bun typecheck`
- `cd packages/opencode && bun test test/machine-sync test/server/httpapi-machine-sync.test.ts test/config/config.test.ts && bun typecheck`
- `cd packages/mobile-gateway && bun test --timeout 180000 && bun typecheck`
- `cd packages/desktop && bun test src/main/sidecar-sync.test.ts src/main/machine-sync.test.ts src/main/mobile-gateway-launch.test.ts src/main/relay-publisher.test.ts && bun typecheck`
- `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/context/settings-sync.test.ts src/components/settings-v2/sync-card-status.test.ts src/components/settings-v2/phone-card.test.tsx src/components/prompt-input-v2.test.ts src/i18n/parity.test.ts && bun typecheck`

Expected: all PASS, all typechecks exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/mobile-gateway/test/sync-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(mobile-gateway): sync two servers end to end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage**

| Spec section / requirement | Task |
| --- | --- |
| Architecture 1: sync routes on the gateway, pairing token only, constant-time compare, phone password does not open them, token opens nothing else | 6 |
| Architecture 2: server endpoints `manifest`, `session bundle`, `settings`, read-only for the peer, reachable only through the gateway | 4, 5 (raw routes, server auth); 6 (gateway allowlist; apply/delete/archive/missing never forwarded) |
| Architecture 3: worker every 60 s, pull manifest, fetch newer bundles, each side writes only its own DB | 7 (worker), 8 (started in the sidecar next to `Server.listen`) |
| Architecture 4: Sync card in Settings → Servers | 11 |
| Peer address and token in desktop settings store, reach sidecar in `start` message, never `process.env`/config | 8, 9 |
| Pairing: code valid 10 min, host + code, fresh 256-bit token + machine name, A records B's URL/name, unpair revokes on peer, one peer | 6, 9, 11 |
| Manifest fields, 30-day tombstones, `session_tombstone` table | 1, 2 |
| Decision rules (newer/missing/archived-earlier → pull, tie keeps local, local busy skip, peer busy skip, tombstone delete + local tombstone, archive propagation, parents first) | 3 (rules), 2 (delete writes local tombstone) |
| Bundle contents, owner claims cleared | 2 |
| Apply: one transaction, delete then insert, project via normal lookup, rollback on failure, reported on card | 2, 4 (422), 7 (failures), 11 (card) |
| Folder missing: still stored, UI notice, card count | 2 (`missingDirectories`), 7, 11 (card + composer notice) |
| First sync batches of 20 with progress | 7, 11 |
| Global config: whole file, mtime newest wins, secret masking, `server` omitted, comment-preserving patch, local secrets kept, absent stays absent, schema validation before write | 5 |
| App preferences: five sections, updated-at stamp, newest wins; not synced: launch store, windows, tabs, drafts, credentials | 10 |
| Card contents and controls; toast only when manual Sync now fails | 11 |
| Errors: unreachable silent + offline, backoff to 5 min after 5 failures and reset; version mismatch pause; 401 "Pair again"; per-chat failure rolled back/listed/retried | 7, 11 |
| Testing: decision unit tests, transaction byte-identical test, secrets tests, two-server E2E with conflict/delete/archive/running skip | 3, 2, 5, 13 |
| Extra requirement: Phone access switch, OFF by default, persisted in desktop store, gateway runs when phone access on OR peer paired, phone routes 404 when off, live without restart | 6 (404 gating, live), 8 (gateway lifecycle), 9 (store + IPC), 12 (switch UI) |

**Placeholder scan:** every code step carries complete code; the only generated artefact (Task 1 migration) is produced by the repo's generator with its exact expected content and a `--check` verification. No "TBD", no "similar to Task N".

**Name/type consistency checked across tasks:** `MachineSyncStore.{manifest,bundle,apply,remove,archive,missingDirectories,isBundle,BusyError,ApplyError}` (2 → 4); `MachineSyncPaths` (4 → 5, tests); `MachineSyncConfig.{sanitizeConfig,applyPeerConfig,SECRET_PLACEHOLDER}` + `Config.{globalConfigFile,validateText}` (5); `Manifest`/`ManifestSession`/`decide`/`isManifest` (3 → 7, 13); `SyncGate` methods `phoneAccess/paused/peer/prefs/pairingActive/authorized/update/setPairingCode/pair/revoke/countSent/takeSent` (6 → 7, 8, 13); `SyncStatus`/`initialStatus`/`nextDelay`/`createSyncWorker`/`SyncWorker` (7 → 8, 9, 13); `SidecarSyncStart/Command/Message`, `parsePeer`, `parsePrefs`, `parseSyncStart`, `parseSyncCommand`, `isSyncMessage`, `gatewayWanted` (8 → 9); `createMachineSync`/`readSyncStart`/`MachineSync` (9); `MachineSyncPlatform`/`MachineSyncStatus`/`MachineSyncPrefs` (9 → 10, 11); store keys `phoneAccess`, `syncPeer`, `syncPaused`, `syncPrefs` (8 → 9); IPC channel names (9 preload ↔ ipc); i18n keys `server.sync.*` (31) and `server.phone.access.*` (3) present in both `en.ts` and the fallback list.
