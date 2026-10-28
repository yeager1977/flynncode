import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { eq, inArray, sql } from "drizzle-orm"
import { Effect, Exit, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient } from "effect/unstable/http"
import { httpClient } from "@flynncode/core/effect/app-node-platform"
import { Global } from "@flynncode/core/global"
import { ModelV2 } from "@flynncode/core/model"
import { Npm } from "@flynncode/core/npm"
import { ProviderV2 } from "@flynncode/core/provider"
import { Hash } from "@flynncode/core/util/hash"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { FSUtil } from "@flynncode/core/fs-util"
import { Database } from "@flynncode/core/database/database"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionMessageTable,
  SessionScheduleTable,
  SessionTable,
  SessionTombstoneTable,
} from "@flynncode/core/session/sql"
import { SessionMessage } from "@flynncode/core/session/message"
import { SessionExecution } from "@flynncode/core/session/execution"
import { SessionProjector } from "@flynncode/core/session/projector"
import { ConfigV1 } from "@flynncode/core/v1/config/config"
import { InvalidError } from "@flynncode/core/v1/config/error"
import type { SessionV1 } from "@flynncode/core/v1/session"
import { SessionRetention as RetentionSchema } from "@flynncode/schema/session-retention"
import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { MachineSyncStore } from "@/machine-sync/store"
import { ConfigParse } from "@/config/parse"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Scheduler } from "@/schedule/scheduler"
import { ScheduleStore } from "@/schedule/store"
import { SessionRetention } from "@/session/retention/service"
import { SessionRetentionQuery } from "@/session/retention/query"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { BackgroundShells } from "@/shell/background/service"
import { Worktree } from "@/worktree"
import { decide, decidePush, type Manifest, type ManifestSession } from "../../../mobile-gateway/src/sync-decide"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestConfig } from "../fixture/config"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"

// Every pass runs against the test database (under the preload's temporary XDG data directory) with an injected
// clock that runs ahead of the rows' wall-clock stamps.

const DAY = 24 * 60 * 60 * 1000

// `getGlobal` reads this on every call, so a test can change the period between passes or make the config invalid.
const global: { current: Effect.Effect<ConfigV1.Info> } = { current: Effect.succeed({}) }

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionRetention.node,
      Session.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      ScheduleStore.node,
      BackgroundShells.node,
      Database.node,
      Worktree.node,
      Project.node,
      FSUtil.node,
      SessionStatus.node,
      Config.node,
      MachineSyncStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
      [Config.node, TestConfig.layer({ getGlobal: () => Effect.suspend(() => global.current) })],
      // No V2 turn runs in these tests.
      [
        SessionExecution.node,
        Layer.succeed(
          SessionExecution.Service,
          SessionExecution.Service.of({
            active: Effect.succeed(new Set()),
            resume: () => Effect.void,
            wake: () => Effect.void,
            interrupt: () => Effect.void,
          }),
        ),
      ],
    ],
  ),
)

// The real config loader over `Global.Path.config`, for the invalid-config case.
const realConfig = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [
    httpClient,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.die(new Error(`unexpected request: ${request.url}`))),
    ),
  ],
])

afterEach(async () => {
  global.current = Effect.succeed({})
  SessionRetention.enable(false)
  delete process.env["SYNC_HUB_MODE"]
  await rm(SessionRetention.defaultStatePath(), { force: true })
  await disposeAllInstances()
  await resetDatabase()
})

test("never runs against the owner's database", () => {
  expect(Database.path() === ":memory:" || Database.path().startsWith(os.tmpdir())).toBe(true)
  expect(Database.path()).not.toContain(path.join(os.homedir(), ".local", "share", "opencode"))
})

const statePath = Effect.gen(function* () {
  const test = yield* TestInstance
  return path.join(test.directory, "retention-state.json")
})

const syncPath = Effect.gen(function* () {
  const test = yield* TestInstance
  return path.join(test.directory, "retention-sync.json")
})

// A retention instance whose first run already happened at the default period, so passes delete right away.
const ready = Effect.fnUntraced(function* (input: { now: () => Date; lock?: string }) {
  const state = yield* statePath
  yield* Effect.promise(() => Bun.write(state, JSON.stringify({ completedAt: 0, periodDays: 30 })))
  return yield* SessionRetention.make({ now: input.now, statePath: state, syncPath: yield* syncPath, lock: input.lock })
})

const readState = Effect.gen(function* () {
  const file = Bun.file(yield* statePath)
  if (!(yield* Effect.promise(() => file.exists()))) return {}
  return yield* Effect.promise(() => file.json() as Promise<Record<string, unknown>>)
})

// An assistant reply in the session, unfinished unless `completed` is given.
const reply = Effect.fnUntraced(function* (sessionID: SessionID, completed?: number) {
  const sessions = yield* Session.Service
  const test = yield* TestInstance
  const user = yield* message(sessionID)
  return yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: test.directory, root: test.directory },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    parentID: user.messageID,
    time: completed === undefined ? { created: Date.now() } : { created: Date.now(), completed },
  } as SessionV1.Assistant)
})

const metadata = Effect.fnUntraced(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  return (yield* sessions.get(sessionID)).metadata ?? {}
})

const message = Effect.fnUntraced(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const messageID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: messageID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
  } as SessionV1.User)
  const partID = PartID.ascending()
  yield* sessions.updatePart({ id: partID, sessionID, messageID, type: "text", text: "hello" } as SessionV1.Part)
  return { messageID, partID }
})

// A root with a sub-agent child and grandchild; the grandchild has a message and a part.
const tree = Effect.fnUntraced(function* (title = "tree") {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ title })
  const child = yield* sessions.create({ parentID: root.id, title: `${title} child` })
  const grandchild = yield* sessions.create({ parentID: child.id, title: `${title} grandchild` })
  const written = yield* message(grandchild.id)
  return { root, child, grandchild, ...written, ids: [root.id, child.id, grandchild.id] }
})

const remaining = Effect.fnUntraced(function* (ids: SessionID[]) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(inArray(SessionTable.id, ids))
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => row.id).sort()
})

// Moves every row of the sessions to `time`.
const age = Effect.fnUntraced(function* (ids: SessionID[], time: number) {
  const { db } = yield* Database.Service
  yield* db
    .update(SessionTable)
    .set({ time_updated: time })
    .where(inArray(SessionTable.id, ids))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(MessageTable)
    .set({ time_updated: time })
    .where(inArray(MessageTable.session_id, ids))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(PartTable)
    .set({ time_updated: time })
    .where(inArray(PartTable.session_id, ids))
    .run()
    .pipe(Effect.orDie)
})

describe("session retention", () => {
  it.instance("deletes a whole inactive tree and keeps a tree with recent descendant activity", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const stale = yield* tree("stale")
      const busy = yield* tree("busy")
      const now = new Date(Date.now() + 40 * DAY)
      // Only the grandchild's part is recent: the whole tree counts as active.
      yield* db
        .update(PartTable)
        .set({ time_updated: now.getTime() - DAY })
        .where(inArray(PartTable.id, [busy.partID]))
        .run()
        .pipe(Effect.orDie)
      const retention = yield* ready({ now: () => now })

      const summary = yield* retention.pass()

      expect(yield* remaining([...stale.ids, ...busy.ids])).toEqual([...busy.ids].sort())
      expect(summary).toMatchObject({
        cleanupPeriodDays: 30,
        sessions: 6,
        trees: 2,
        eligible: 1,
        deleted: 1,
        removed: 3,
      })
    }),
  )

  it.instance("treats activity in the future as active", () =>
    Effect.gen(function* () {
      const skewed = yield* tree("skewed")
      const now = new Date(Date.now() + 40 * DAY)
      yield* age(skewed.ids, now.getTime() - 40 * DAY)
      yield* age([skewed.child.id], now.getTime() + DAY)
      const retention = yield* ready({ now: () => now })

      yield* retention.pass()

      expect(yield* remaining(skewed.ids)).toEqual([...skewed.ids].sort())
    }),
  )

  it.instance("skips kept roots, unexpired scheduled jobs and running background shells anywhere in the tree", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const shells = yield* BackgroundShells.Service
      const kept = yield* tree("kept")
      const keptChild = yield* tree("kept child")
      const scheduled = yield* tree("scheduled")
      const shelled = yield* tree("shelled")
      const expired = yield* tree("expired")
      yield* sessions.setMetadata({ sessionID: kept.root.id, metadata: { ...kept.root.metadata, keep: true } })
      // Keep is read from the root only: a sub-agent cannot exempt its tree.
      yield* sessions.setMetadata({ sessionID: keptChild.child.id, metadata: { keep: true } })
      yield* store.create({
        sessionID: scheduled.grandchild.id,
        kind: "wakeup",
        prompt: "look again",
        recurring: false,
        runAt: new Date(Date.now() + 60_000),
        now: new Date(),
      })
      // A recurring cron job expires after 7 days; past that it no longer protects its tree.
      yield* store.create({
        sessionID: expired.child.id,
        kind: "cron",
        cron: "0 9 * * *",
        prompt: "daily",
        recurring: true,
        now: new Date(),
      })
      yield* Effect.acquireRelease(
        shells.start({
          sessionID: shelled.child.id,
          command: "sleep 30",
          cwd: test.directory,
          directory: test.directory,
          env: { PATH: process.env.PATH ?? "" },
          shell: "/bin/sh",
        }),
        () => shells.killAll(),
      )
      const now = new Date(Date.now() + 40 * DAY)
      const retention = yield* ready({ now: () => now })

      const summary = yield* retention.pass()

      expect(yield* remaining([...kept.ids, ...scheduled.ids, ...shelled.ids])).toEqual(
        [...kept.ids, ...scheduled.ids, ...shelled.ids].sort(),
      )
      expect(yield* remaining([...keptChild.ids, ...expired.ids])).toEqual([])
      expect(summary).toMatchObject({ trees: 5, eligible: 2, deleted: 2 })
    }),
  )

  it.instance("deletes at most 50 trees per pass, oldest first", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const roots = yield* Effect.forEach(
        Array.from({ length: 55 }, (_, index) => index),
        (index) => sessions.create({ title: `old ${index}` }),
      )
      const now = new Date(Date.now() + 40 * DAY)
      // The last five are the newest, so they are left for the next pass.
      yield* Effect.forEach(roots, (root, index) => age([root.id], now.getTime() - 100 * DAY + index * 1000))
      const retention = yield* ready({ now: () => now })
      const ids = roots.map((root) => root.id)

      expect(yield* retention.pass()).toMatchObject({ eligible: 55, deleted: 50 })
      expect(yield* remaining(ids)).toEqual(ids.slice(50).sort())
      expect(yield* retention.pass()).toMatchObject({ eligible: 5, deleted: 5 })
      expect(yield* remaining(ids)).toEqual([])
    }),
  )

  it.instance("delays a first pass with more than 20 trees by 24 hours, across a restart", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const roots = yield* Effect.forEach(
        Array.from({ length: 21 }, (_, index) => index),
        (index) => sessions.create({ title: `first ${index}` }),
      )
      const ids = roots.map((root) => root.id)
      const state = yield* statePath
      const now = new Date(Date.now() + 40 * DAY)
      const first = yield* SessionRetention.make({ now: () => now, statePath: state })

      expect(yield* first.pass()).toMatchObject({ eligible: 21, deleted: 0, delayedUntil: now.getTime() + DAY })
      expect(yield* remaining(ids)).toHaveLength(21)
      expect(yield* Effect.promise(() => Bun.file(state).json())).toEqual({
        firstRunAt: now.getTime() + DAY,
        pendingFirstRunCount: 21,
        pendingPeriodDays: 30,
      })
      expect(yield* first.status()).toMatchObject({ firstRunAt: now.getTime() + DAY, pendingFirstRunCount: 21 })

      // A restart reads the delay back instead of starting a new one.
      const restarted = yield* SessionRetention.make({ now: () => now, statePath: state })
      expect(yield* restarted.pass(new Date(now.getTime() + DAY - 1))).toMatchObject({ deleted: 0 })
      expect(yield* remaining(ids)).toHaveLength(21)

      expect(yield* restarted.pass(new Date(now.getTime() + DAY))).toMatchObject({ deleted: 21 })
      expect(yield* remaining(ids)).toEqual([])
      const done = yield* restarted.status(new Date(now.getTime() + DAY))
      expect(done.firstRunAt).toBeUndefined()
      expect(done.pendingFirstRunCount).toBeUndefined()

      // Later passes never delay again.
      const later = yield* Effect.forEach(
        Array.from({ length: 21 }, (_, index) => index),
        (index) => sessions.create({ title: `later ${index}` }),
      )
      expect(yield* restarted.pass(new Date(now.getTime() + 60 * DAY))).toMatchObject({ eligible: 21, deleted: 21 })
      expect(yield* remaining(later.map((root) => root.id))).toEqual([])
    }),
  )

  it.instance("runs a first pass with 20 or fewer trees right away", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const roots = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) => sessions.create({ title: `few ${index}` }),
      )
      const now = new Date(Date.now() + 40 * DAY)
      const retention = yield* SessionRetention.make({ now: () => now, statePath: yield* statePath })

      expect(yield* retention.pass()).toMatchObject({ eligible: 20, deleted: 20 })
      expect(yield* remaining(roots.map((root) => root.id))).toEqual([])
    }),
  )

  it.instance("uses cleanupPeriodDays, 30 by default, and picks up a changed value on the next pass", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const recent = yield* sessions.create({ title: "ten days" })
      const old = yield* sessions.create({ title: "thirty one days" })
      const now = new Date(Date.now() + 40 * DAY)
      yield* age([recent.id], now.getTime() - 10 * DAY)
      yield* age([old.id], now.getTime() - 31 * DAY)
      const retention = yield* ready({ now: () => now })

      expect(yield* retention.pass()).toMatchObject({ cleanupPeriodDays: 30, deleted: 1 })
      expect(yield* remaining([recent.id, old.id])).toEqual([recent.id])

      global.current = Effect.succeed({ cleanupPeriodDays: 7 })
      expect(yield* retention.pass()).toMatchObject({ cleanupPeriodDays: 7, deleted: 1 })
      expect(yield* remaining([recent.id])).toEqual([])
    }),
  )

  it.instance("never deletes while the real config loader finds an invalid cleanupPeriodDays", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "invalid config" })
      const dir = path.join(test.directory, "global-config")
      yield* Effect.promise(() => Bun.write(path.join(dir, "opencode.jsonc"), JSON.stringify({ cleanupPeriodDays: 0 })))
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous
        }),
      )
      global.current = Config.use.getGlobal().pipe(Effect.provide(realConfig))
      const retention = yield* ready({ now: () => new Date(Date.now() + 400 * DAY) })

      expect(Exit.isFailure(yield* retention.pass().pipe(Effect.exit))).toBe(true)
      expect(yield* remaining([root.id])).toEqual([root.id])
    }),
  )

  it.instance("deletes through the manual-delete path, leaving tombstones, and announces the pass", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const stale = yield* tree("tombstoned")
      const judged = (yield* SessionRetentionQuery.trees(yield* Database.Service, Date.now(), stale.root.id))[0].latest
      const before = Date.now()
      const retention = yield* ready({ now: () => new Date(Date.now() + 40 * DAY) })
      const event = yield* waitGlobalBusEvent({
        predicate: (item) => item.payload.type === RetentionSchema.Event.Updated.type,
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      yield* retention.pass()

      const tombstones = yield* db
        .select()
        .from(SessionTombstoneTable)
        .where(inArray(SessionTombstoneTable.id, stale.ids))
        .all()
        .pipe(Effect.orDie)
      expect(tombstones.map((row) => row.id).sort()).toEqual([...stale.ids].sort())
      // Stamped with the tree's newest activity plus 1 ms, not the deletion time; recorded now, for expiry.
      expect(tombstones.map((row) => row.time_deleted)).toEqual(stale.ids.map(() => judged + 1))
      expect(tombstones.every((row) => (row.time_recorded ?? 0) >= before)).toBe(true)
      const parts = yield* db
        .select({ id: PartTable.id })
        .from(PartTable)
        .where(inArray(PartTable.session_id, stale.ids))
        .all()
        .pipe(Effect.orDie)
      expect(parts).toEqual([])
      expect((yield* Fiber.join(event)).directory).toBe("global")
    }),
  )

  it.instance(
    "disposes a deleted tree's task worktree, as a manual delete does",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const directory = path.join(test.directory, ".opencode", "worktrees", "retained")
        yield* Effect.promise(() =>
          Bun.$`git worktree add -b opencode/retained ${directory}`.cwd(test.directory).quiet(),
        )
        const root = yield* sessions.create({ title: "worktree", metadata: { disposable: true, worktree: directory } })
        const retention = yield* ready({ now: () => new Date(Date.now() + 40 * DAY) })

        expect(yield* retention.pass()).toMatchObject({ deleted: 1, failed: 0 })
        expect(yield* remaining([root.id])).toEqual([])
        expect(yield* fs.exists(directory)).toBe(false)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance("still deletes a tree whose folder is gone, without an instance to run in", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const stale = yield* tree("orphaned folder")
      yield* db
        .update(SessionTable)
        .set({ directory: path.join(test.directory, "gone") })
        .where(inArray(SessionTable.id, stale.ids))
        .run()
        .pipe(Effect.orDie)
      const retention = yield* ready({ now: () => new Date(Date.now() + 40 * DAY) })

      expect(yield* retention.pass()).toMatchObject({ deleted: 1, removed: 3, failed: 0 })
      expect(yield* remaining(stale.ids)).toEqual([])
    }),
  )

  it.instance("runs passes only in the process holding the leader lock", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "led" })
      const now = new Date(Date.now() + 40 * DAY)
      const lock = `retention-test:${test.directory}`
      const first = yield* ready({ now: () => now, lock })
      const second = yield* ready({ now: () => now, lock })

      const polled = yield* Effect.all([first.poll(), second.poll()], { concurrency: "unbounded" })

      expect(polled.filter(Boolean)).toHaveLength(1)
      expect(yield* (polled[0] ? second : first).poll()).toBe(false)
      expect(yield* remaining([root.id])).toEqual([])
    }),
  )

  it.instance("lists roots due within 3 days with their deletion time", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const soon = yield* sessions.create({ title: "soon" })
      const later = yield* sessions.create({ title: "later" })
      const kept = yield* sessions.create({ title: "kept", metadata: { keep: true } })
      const now = new Date(Date.now() + 40 * DAY)
      yield* age([soon.id, kept.id], now.getTime() - 28 * DAY)
      yield* age([later.id], now.getTime() - 20 * DAY)
      const retention = yield* ready({ now: () => now })

      expect(yield* retention.status()).toEqual({
        cleanupPeriodDays: 30,
        expiring: [{ sessionID: soon.id, deletesAt: now.getTime() + 2 * DAY }],
        kept: [kept.id],
        held: [],
      })
    }),
  )

  it.instance("reads tree activity from indexes, never scanning message or part rows", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const plan = yield* db
        .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${SessionRetentionQuery.statement(Date.now())}`)
        .pipe(Effect.orDie)
      const details = plan.map((row) => row.detail)
      expect(
        details.some((detail) =>
          /SCAN (message|part|session_message|todo|session_folder|session_input)\b/.test(detail),
        ),
      ).toBe(false)
      expect(details.some((detail) => detail.includes("part_session_time_updated_idx"))).toBe(true)
      expect(details.some((detail) => detail.includes("message_session_time_updated_idx"))).toBe(true)
    }),
  )
})

describe("cleanupPeriodDays", () => {
  test("is a whole number of days, at least 1", () => {
    const decode = (value: unknown) => () => ConfigParse.schema(ConfigV1.Info, { cleanupPeriodDays: value }, "test")
    expect(decode(1)().cleanupPeriodDays).toBe(1)
    expect(decode(365)().cleanupPeriodDays).toBe(365)
    expect(decode(0)).toThrow(InvalidError)
    expect(decode(-1)).toThrow(InvalidError)
    expect(decode(1.5)).toThrow(InvalidError)
    expect(decode("30")).toThrow(InvalidError)
  })
})

describe("session retention entry points", () => {
  test("only an opted-in process that is not the sync hub polls", () => {
    expect(SessionRetention.enabled()).toBe(false)
    // What `serve`, `web` and `acp` do: scheduler leadership alone no longer runs retention.
    Scheduler.enableLeadership("serve")
    expect(SessionRetention.enabled()).toBe(false)
    SessionRetention.enable()
    expect(SessionRetention.enabled()).toBe(true)
    process.env["SYNC_HUB_MODE"] = "1"
    expect(SessionRetention.enabled()).toBe(false)
  })

  test("the desktop sidecar and the TUI worker opt in; serve, web and acp do not", async () => {
    const source = (file: string) => readFile(path.join(import.meta.dir, "../..", file), "utf8")
    expect(await source("src/cli/tui/worker.ts")).toContain("SessionRetention.enable()")
    expect(await source("../desktop/src/main/sidecar.ts")).toContain("SessionRetention.enable()")
    for (const file of ["src/cli/cmd/serve.ts", "src/cli/cmd/web.ts", "src/cli/cmd/acp.ts"])
      expect(await source(file)).not.toContain("SessionRetention")
  })

  // Starts the real timer under a test clock, runs past the first pass, and reports whether the stale tree is gone.
  const firstPass = Effect.fnUntraced(function* (now: Date) {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ title: "timer" })
    yield* Effect.gen(function* () {
      const passed = yield* waitGlobalBusEvent({
        predicate: (item) => item.payload.type === RetentionSchema.Event.Updated.type,
      }).pipe(Effect.forkChild)
      yield* Layer.build(SessionRetention.layer(() => now))
      yield* TestClock.adjust(SessionRetention.FIRST_PASS)
      // A poll does real file and database work; give it time to finish (or to never start).
      yield* Effect.promise(() => Bun.sleep(500))
      yield* Fiber.interrupt(passed)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()))
    return (yield* remaining([root.id])).length === 0
  })

  it.instance("a hub-mode process never polls, even when enabled", () =>
    Effect.gen(function* () {
      SessionRetention.enable()
      process.env["SYNC_HUB_MODE"] = "1"
      expect(yield* firstPass(new Date(Date.now() + 40 * DAY))).toBe(false)
    }),
  )

  it.instance("a process that never opted in, like serve, never polls", () =>
    Effect.gen(function* () {
      Scheduler.enableLeadership("serve")
      expect(yield* firstPass(new Date(Date.now() + 40 * DAY))).toBe(false)
    }),
  )

  it.instance("an opted-in process polls after the first-pass delay", () =>
    Effect.gen(function* () {
      SessionRetention.enable()
      expect(yield* firstPass(new Date(Date.now() + 40 * DAY))).toBe(true)
    }),
  )
})

describe("session retention across machines", () => {
  // The manifest the sync worker reads from this database.
  const manifest = Effect.gen(function* () {
    const store = yield* MachineSyncStore.Service
    return (yield* store.manifest()) as Manifest
  })

  const copy = (id: string, timeUpdated: number, extra: Partial<ManifestSession> = {}): ManifestSession => ({
    id,
    parentID: null,
    timeUpdated,
    timeArchived: null,
    busy: false,
    ...extra,
  })

  it.instance("a stale machine's retention delete never outranks newer activity on a peer", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      // The laptop's copy of S was last written on day L, when it last synced.
      const s = yield* sessions.create({ title: "S" })
      const day = (yield* SessionRetentionQuery.trees(yield* Database.Service, Date.now(), s.id))[0].latest
      // Day L + 31: the laptop deletes S as inactive.
      const retention = yield* ready({ now: () => new Date(day + 31 * DAY) })
      expect(yield* retention.pass()).toMatchObject({ deleted: 1 })
      const laptop = yield* manifest
      expect(laptop.tombstones).toEqual([{ id: s.id, timeDeleted: day + 1, root: s.id }])

      // Meanwhile the desktop kept working on S (day L + 10); the hub has that copy.
      const hub = { ...laptop, sessions: [copy(s.id, day + 10 * DAY)], tombstones: [] }
      const desktop = { ...laptop, sessions: [copy(s.id, day + 10 * DAY)], tombstones: [] }
      // Back home, the laptop does not push its delete, and pulls S back instead.
      expect(decidePush({ local: laptop, hub }).filter((action) => action.type === "delete")).toEqual([])
      expect(decide({ local: laptop, peer: hub })).toEqual([{ type: "pull", id: s.id }])
      // Even a tombstone that reached the hub would not delete the desktop's newer copy.
      expect(decide({ local: desktop, peer: { ...hub, sessions: [], tombstones: laptop.tombstones } })).toEqual([])

      // Without newer activity anywhere, the delete still propagates.
      const idle = { ...laptop, sessions: [copy(s.id, day)], tombstones: [] }
      expect(decidePush({ local: laptop, hub: idle })).toEqual([
        { type: "delete", id: s.id, timeDeleted: day + 1, root: s.id },
      ])
      expect(decide({ local: idle, peer: { ...idle, sessions: [], tombstones: laptop.tombstones } })).toEqual([
        { type: "delete", id: s.id, timeDeleted: day + 1, root: s.id },
      ])
    }),
  )

  it.instance("a retention delete keeps the whole tree wherever any of it is newer, kept or held", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      // Tree R + sub-agent C, last written on the laptop on day L; C's own last write is two days older.
      const root = yield* sessions.create({ title: "R" })
      const child = yield* sessions.create({ parentID: root.id, title: "C" })
      yield* message(child.id)
      const day = Date.now()
      yield* age([root.id], day)
      yield* age([child.id], day - 2 * DAY)
      const before = yield* manifest
      expect(before.sessions.map((session) => [session.id, session.timeUpdated]).sort()).toEqual(
        [
          [root.id, day],
          [child.id, day - 2 * DAY],
        ].sort(),
      )

      // Day L + 31: the laptop deletes the tree. Every member's tombstone carries the tree's activity and its root.
      const retention = yield* ready({ now: () => new Date(day + 31 * DAY) })
      expect(yield* retention.pass()).toMatchObject({ deleted: 1, removed: 2 })
      const laptop = yield* manifest
      const tombstones = [root.id, child.id].map((id) => ({ id, timeDeleted: day + 1, root: root.id })).sort()
      expect(laptop.tombstones.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
        tombstones.toSorted((a, b) => a.id.localeCompare(b.id)),
      )

      const tree = (rootTime: number, childTime: number, extra: Partial<ManifestSession> = {}): Manifest => ({
        ...laptop,
        tombstones: [],
        sessions: [copy(root.id, rootTime, extra), copy(child.id, childTime, { parentID: root.id })],
      })
      const scenarios = {
        // The desktop kept chatting in R only.
        rootTouched: tree(day + 10 * DAY, day - 2 * DAY),
        // The newer activity is in the sub-agent session.
        childTouched: tree(day, day + 10 * DAY),
        // The desktop kept the tree, or a schedule holds it there, with nothing newer.
        kept: tree(day, day - 2 * DAY, { kept: true }),
      }
      Object.values(scenarios).forEach((desktop) => {
        // The laptop does not push the delete, and pulls every member back, parents first.
        expect(decidePush({ local: laptop, hub: desktop }).filter((action) => action.type === "delete")).toEqual([])
        expect(decide({ local: laptop, peer: desktop })).toEqual([
          { type: "pull", id: root.id },
          { type: "pull", id: child.id },
        ])
        // Tombstones that reached the hub delete no member of the desktop's tree.
        expect(decide({ local: desktop, peer: { ...laptop, sessions: [] } })).toEqual([])
      })

      // Nobody touched the tree since: it is still deleted whole, everywhere.
      const idle = tree(day, day - 2 * DAY)
      const deletes = laptop.tombstones.map((tombstone) => ({ type: "delete" as const, ...tombstone }))
      expect(decidePush({ local: laptop, hub: idle })).toEqual(deletes)
      expect(decide({ local: idle, peer: { ...laptop, sessions: [] } })).toEqual(deletes)
      expect(decide({ local: laptop, peer: idle })).toEqual([])
    }),
  )

  it.instance("dates a tree by its newest V2 input exactly as the sync manifest dates the chat", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "skewed inputs" })
      const day = Date.now()
      yield* age([root.id], day - DAY)
      // Inputs from a peer whose clock ran ahead: the later-admitted one has the older creation time.
      yield* db
        .insert(SessionInputTable)
        .values(
          [
            { seq: 1, time: day + 5_000 },
            { seq: 2, time: day + 3_000 },
          ].map((input) => ({
            id: SessionMessage.ID.make(`msg_input_${input.seq}`),
            session_id: root.id,
            prompt: { text: "hello" },
            delivery: "steer" as const,
            admitted_seq: input.seq,
            promoted_seq: input.seq,
            time_created: input.time,
          })),
        )
        .run()
        .pipe(Effect.orDie)

      const latest = (yield* SessionRetentionQuery.trees(yield* Database.Service, day, root.id))[0]?.latest
      expect(latest).toBe(day + 5_000)
      expect((yield* manifest).sessions.find((session) => session.id === root.id)?.timeUpdated).toBe(latest)
    }),
  )

  it.instance("skips passes while a paired machine has not synced for a day", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "unsynced" })
      const now = new Date(Date.now() + 40 * DAY)
      const sync = yield* syncPath
      const record = (value: object) => Effect.promise(() => Bun.write(sync, JSON.stringify(value)))
      const retention = yield* ready({ now: () => now })

      yield* record({ paired: true, lastCaughtUp: now.getTime() - DAY - 1 })
      expect(yield* retention.pass()).toMatchObject({ eligible: 1, deleted: 0, skipped: "sync-stale" })
      // Paired but never synced since this machine recorded it.
      yield* record({ paired: true })
      expect(yield* retention.pass()).toMatchObject({ deleted: 0, skipped: "sync-stale" })
      expect(yield* remaining([root.id])).toEqual([root.id])

      yield* record({ paired: true, lastCaughtUp: now.getTime() - 60_000 })
      expect(yield* retention.pass()).toMatchObject({ deleted: 1 })
      expect(yield* remaining([root.id])).toEqual([])
    }),
  )

  it.instance("runs when sync is not paired, and records the sidecar's reports", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "unpaired" })
      yield* Effect.promise(() => SessionRetention.recordSync({ paired: false, lastCaughtUp: null }))
      expect(yield* Effect.promise(() => Bun.file(SessionRetention.defaultSyncPath()).json())).toEqual({
        paired: false,
      })
      const retention = yield* SessionRetention.make({
        now: () => new Date(Date.now() + 40 * DAY),
        statePath: yield* statePath,
      })

      expect(yield* retention.pass()).toMatchObject({ deleted: 1 })
      expect(yield* remaining([root.id])).toEqual([])
      yield* Effect.promise(() => rm(SessionRetention.defaultSyncPath(), { force: true }))
    }),
  )

  it.instance("holds a tree with a scheduled job on every machine, and clears only its own hold", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const { db } = yield* Database.Service
      const scheduled = yield* tree("scheduled")
      const foreign = yield* tree("held elsewhere")
      const job = yield* store.create({
        sessionID: scheduled.grandchild.id,
        kind: "wakeup",
        prompt: "look again",
        recurring: false,
        runAt: new Date(Date.now() + 60_000),
        now: new Date(),
      })
      const now = new Date(Date.now() + 40 * DAY)
      // Another machine's job put a hold on this tree; this database has no job for it.
      const sessions = yield* Session.Service
      yield* sessions.updateMetadata({
        sessionID: foreign.root.id,
        update: (value) => ({
          ...value,
          retentionHold: true,
          retentionHoldUntil: now.getTime() + SessionRetention.HOLD_MS,
        }),
      })
      const retention = yield* ready({ now: () => now })

      expect(yield* retention.pass()).toMatchObject({ deleted: 0 })
      expect(yield* metadata(scheduled.root.id)).toMatchObject({
        retentionHold: true,
        retentionHoldUntil: now.getTime() + SessionRetention.HOLD_MS,
      })
      expect((yield* readState).holds).toEqual([scheduled.root.id])
      // The app shows both as held by a schedule.
      expect((yield* retention.status()).held.toSorted()).toEqual([scheduled.root.id, foreign.root.id].sort())

      // Its last job is gone: this machine set that hold, so the next pass clears it. The foreign hold stays.
      yield* db.delete(SessionScheduleTable).where(eq(SessionScheduleTable.id, job.id)).run().pipe(Effect.orDie)
      expect(
        (yield* SessionRetentionQuery.trees(yield* Database.Service, now.getTime(), scheduled.root.id))[0],
      ).toMatchObject({ hold: true, scheduled: false })
      expect(yield* retention.pass(new Date())).toMatchObject({ deleted: 0 })
      expect(yield* metadata(scheduled.root.id)).not.toHaveProperty("retentionHold")
      expect(yield* metadata(scheduled.root.id)).not.toHaveProperty("retentionHoldUntil")
      expect(yield* metadata(foreign.root.id)).toMatchObject({ retentionHold: true })

      // A hold without a job here protects the tree like Keep; the released tree is deleted.
      expect(yield* retention.pass()).toMatchObject({ deleted: 1 })
      expect(yield* remaining([...scheduled.ids, ...foreign.ids])).toEqual([...foreign.ids].sort())
      expect((yield* readState).holds).toEqual([])
    }),
  )
})

describe("session retention schedule holds", () => {
  it.instance("refreshes its hold daily while the job lasts, and a hold nobody refreshes lapses after a week", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const { db } = yield* Database.Service
      const sessions = yield* Session.Service
      const scheduled = yield* tree("scheduled")
      const retired = yield* tree("held by a retired machine")
      const job = yield* store.create({
        sessionID: scheduled.child.id,
        kind: "wakeup",
        prompt: "look again",
        recurring: false,
        runAt: new Date(Date.now() + 60_000),
        now: new Date(),
      })
      const now = Date.now() + 40 * DAY
      // The machine that set this hold, six days ago, was reinstalled: nobody will refresh or clear it.
      yield* sessions.updateMetadata({
        sessionID: retired.root.id,
        update: (value) => ({ ...value, retentionHold: true, retentionHoldUntil: now + DAY }),
      })
      const retention = yield* ready({ now: () => new Date(now) })
      const until = Effect.fnUntraced(function* (id: SessionID) {
        return (yield* metadata(id)).retentionHoldUntil
      })

      expect(yield* retention.pass()).toMatchObject({ deleted: 0 })
      expect(yield* until(scheduled.root.id)).toBe(now + SessionRetention.HOLD_MS)
      // Checked every pass, rewritten (activity that syncs) only once the hold is a day old.
      expect(yield* retention.pass(new Date(now + 2 * 60 * 60 * 1000))).toMatchObject({ deleted: 0 })
      expect(yield* until(scheduled.root.id)).toBe(now + SessionRetention.HOLD_MS)
      // A week after its last refresh the retired machine's hold has lapsed: that tree is deleted like any other.
      expect(yield* retention.pass(new Date(now + DAY + 1))).toMatchObject({ deleted: 1 })
      expect(yield* until(scheduled.root.id)).toBe(now + DAY + 1 + SessionRetention.HOLD_MS)
      expect(yield* remaining(retired.ids)).toEqual([])
      expect((yield* retention.status(new Date(now + DAY + 1))).held).toEqual([scheduled.root.id])

      // The job is gone and this machine lost its state file, so it no longer clears the hold it set. It lapses too.
      yield* db.delete(SessionScheduleTable).where(eq(SessionScheduleTable.id, job.id)).run().pipe(Effect.orDie)
      const lost = yield* ready({ now: () => new Date(now + DAY + 2 + SessionRetention.HOLD_MS) })
      expect(yield* lost.pass()).toMatchObject({ deleted: 1 })
      expect(yield* remaining(scheduled.ids)).toEqual([])
    }),
  )
})

describe("session retention busy trees", () => {
  it.instance("skips a tree with a running turn in this process until it goes idle", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const running = yield* tree("running")
      const retention = yield* ready({ now: () => new Date(Date.now() + 40 * DAY) })
      yield* status.set(running.child.id, { type: "busy" })

      expect(yield* retention.pass()).toMatchObject({ eligible: 0, deleted: 0 })

      yield* status.set(running.child.id, { type: "idle" })
      expect(yield* retention.pass()).toMatchObject({ deleted: 1 })
    }),
  )

  it.instance("skips a tree waiting on a permission or a question", () =>
    Effect.gen(function* () {
      const asking = yield* tree("asking")
      const retention = yield* ready({ now: () => new Date(Date.now() + 40 * DAY) })
      const emit = (type: string, properties: Record<string, unknown>) =>
        Effect.sync(() => GlobalBus.emit("event", { directory: "/elsewhere", payload: { type, properties } }))

      yield* emit("permission.asked", { id: "per_1", sessionID: asking.grandchild.id })
      yield* emit("question.asked", { id: "que_1", sessionID: asking.root.id })
      expect(yield* retention.pass()).toMatchObject({ deleted: 0 })
      yield* emit("permission.replied", { requestID: "per_1", sessionID: asking.grandchild.id, reply: "once" })
      expect(yield* retention.pass()).toMatchObject({ deleted: 0 })
      yield* emit("question.rejected", { requestID: "que_1", sessionID: asking.root.id })
      expect(yield* retention.pass()).toMatchObject({ deleted: 1 })
    }),
  )

  it.instance("skips a tree whose latest assistant message is unfinished in the database", () =>
    Effect.gen(function* () {
      const unfinished = yield* tree("unfinished")
      const orphaned = yield* tree("orphaned")
      const finished = yield* tree("finished")
      // Another process may be driving this turn: nothing here says it ended.
      yield* reply(unfinished.child.id)
      // A newer assistant message ends an older unfinished one.
      yield* reply(orphaned.child.id)
      yield* reply(orphaned.child.id, Date.now())
      yield* reply(finished.child.id, Date.now())
      const retention = yield* ready({ now: () => new Date(Date.now() + 40 * DAY) })

      expect(yield* retention.pass()).toMatchObject({ eligible: 2, deleted: 2 })
      expect(yield* remaining([...unfinished.ids, ...orphaned.ids, ...finished.ids])).toEqual(
        [...unfinished.ids].sort(),
      )
    }),
  )
  it.instance("skips a tree whose V2 turn waits in another process, by what the database persists", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const waiting = yield* tree("v2 waiting")
      const queued = yield* tree("v2 queued")
      const done = yield* tree("v2 done")
      const assistant = (sessionID: SessionID, seq: number, completed?: number) =>
        db
          .insert(SessionMessageTable)
          .values({
            id: SessionMessage.ID.make(`msg_v2_${sessionID}_${seq}`),
            session_id: sessionID,
            type: "assistant",
            seq,
            time_created: Date.now(),
            time_updated: Date.now(),
            data: {
              agent: "build",
              model: { id: "test-model", providerID: "test" },
              content: [],
              time: completed === undefined ? { created: Date.now() } : { created: Date.now(), completed },
            },
          } as typeof SessionMessageTable.$inferInsert)
          .run()
          .pipe(Effect.orDie)
      // Another process's V2 turn waits on a permission: its assistant message stays open, and it writes nothing.
      yield* assistant(waiting.grandchild.id, 1)
      // An input admitted for a turn that has not started yet.
      yield* db
        .insert(SessionInputTable)
        .values({
          id: SessionMessage.ID.make(`msg_input_${queued.child.id}`),
          session_id: queued.child.id,
          prompt: { text: "next" },
          delivery: "queue",
          admitted_seq: 1,
          time_created: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      // A newer completed V2 assistant message ends an older open one.
      yield* assistant(done.child.id, 1)
      yield* assistant(done.child.id, 2, Date.now())
      const retention = yield* ready({ now: () => new Date(Date.now() + 40 * DAY) })

      expect(yield* retention.pass()).toMatchObject({ eligible: 1, deleted: 1 })
      expect(yield* remaining([...waiting.ids, ...queued.ids, ...done.ids])).toEqual(
        [...waiting.ids, ...queued.ids].sort(),
      )
    }),
  )
})

describe("session retention deletion", () => {
  it.instance("deletes without loading the tree's project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const instances = yield* InstanceStore.Service
      const { db } = yield* Database.Service
      const elsewhere = path.join(test.directory, "elsewhere")
      yield* Effect.promise(() => mkdir(elsewhere, { recursive: true }))
      const stale = yield* tree("elsewhere")
      yield* db
        .update(SessionTable)
        .set({ directory: elsewhere })
        .where(inArray(SessionTable.id, stale.ids))
        .run()
        .pipe(Effect.orDie)
      const retention = yield* ready({ now: () => new Date(Date.now() + 40 * DAY) })

      expect(yield* retention.pass()).toMatchObject({ deleted: 1, removed: 3, failed: 0 })
      expect(yield* remaining(stale.ids)).toEqual([])
      expect([...(yield* instances.loadedDirectories())].some((directory) => directory.startsWith(elsewhere))).toBe(
        false,
      )
    }),
  )

  it.instance("stops deleting once another process took the leader lock", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const lock = `retention-lost:${test.directory}`
      const now = new Date(Date.now() + 40 * DAY)
      const retention = yield* ready({ now: () => now, lock })
      expect(yield* retention.poll()).toBe(true)
      const root = yield* sessions.create({ title: "after a stall" })
      yield* age([root.id], now.getTime() - 40 * DAY)
      // After a stall past the stale time, another process broke the lock and took it.
      yield* Effect.promise(() =>
        writeFile(
          path.join(Global.Path.state, "locks", `${Hash.fast(lock)}.lock`, "meta.json"),
          JSON.stringify({ token: "another process" }),
        ),
      )

      expect(yield* retention.poll()).toBe(false)
      expect(yield* remaining([root.id])).toEqual([root.id])
    }),
  )
})

describe("session retention surges", () => {
  it.instance("a first pass with nothing to delete does not spend the first-run delay", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const state = yield* statePath
      const now = new Date(Date.now() + 40 * DAY)
      const retention = yield* SessionRetention.make({ now: () => now, statePath: state, syncPath: yield* syncPath })

      expect(yield* retention.pass(new Date())).toMatchObject({ eligible: 0, deleted: 0 })
      expect(yield* readState).not.toHaveProperty("completedAt")

      const roots = yield* Effect.forEach(
        Array.from({ length: 21 }, (_, index) => index),
        (index) => sessions.create({ title: `first ${index}` }),
      )
      expect(yield* retention.pass()).toMatchObject({ eligible: 21, deleted: 0, delayedUntil: now.getTime() + DAY })
      expect(yield* remaining(roots.map((root) => root.id))).toHaveLength(21)
    }),
  )

  it.instance("delays a lowered period that makes more than 20 trees newly eligible, and announces it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const now = new Date(Date.now() + 40 * DAY)
      const roots = yield* Effect.forEach(
        Array.from({ length: 21 }, (_, index) => index),
        (index) => sessions.create({ title: `ten days ${index}` }),
      )
      const ids = roots.map((root) => root.id)
      yield* age(ids, now.getTime() - 10 * DAY)
      const retention = yield* ready({ now: () => now })
      expect(yield* retention.pass()).toMatchObject({ cleanupPeriodDays: 30, eligible: 0 })

      global.current = Effect.succeed({ cleanupPeriodDays: 7 })
      expect(yield* retention.pass()).toMatchObject({ eligible: 21, deleted: 0, delayedUntil: now.getTime() + DAY })
      expect(yield* retention.status()).toMatchObject({ firstRunAt: now.getTime() + DAY, pendingFirstRunCount: 21 })
      expect(yield* remaining(ids)).toHaveLength(21)

      expect(yield* retention.pass(new Date(now.getTime() + DAY))).toMatchObject({ deleted: 21 })
      expect(yield* retention.status(new Date(now.getTime() + DAY))).not.toHaveProperty("firstRunAt")
    }),
  )

  it.instance(
    "lowering the period again during a delay recounts it, and restarts it with a new notice past the limit",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const now = Date.now() + 40 * DAY
        const roots = Effect.fnUntraced(function* (count: number, title: string, inactive: number) {
          const created = yield* Effect.forEach(
            Array.from({ length: count }, (_, index) => index),
            (index) => sessions.create({ title: `${title} ${index}` }),
          )
          yield* age(
            created.map((root) => root.id),
            now - inactive,
          )
          return created
        })
        yield* roots(21, "ten days", 10 * DAY)
        const retention = yield* ready({ now: () => new Date(now) })
        global.current = Effect.succeed({ cleanupPeriodDays: 7 })
        expect(yield* retention.pass()).toMatchObject({ eligible: 21, deleted: 0, delayedUntil: now + DAY })

        // Trees that age into the announced period only change the count.
        yield* roots(5, "eight days", 8 * DAY)
        expect(yield* retention.pass()).toMatchObject({ eligible: 26, delayedUntil: now + DAY })
        expect(yield* retention.status()).toMatchObject({ firstRunAt: now + DAY, pendingFirstRunCount: 26 })

        // Lowered to 1 day an hour later: 21 more trees are newly eligible, so the delay starts over and is announced.
        yield* roots(21, "two days", 2 * DAY)
        global.current = Effect.succeed({ cleanupPeriodDays: 1 })
        const later = now + 60 * 60 * 1000
        expect(yield* retention.pass(new Date(later))).toMatchObject({
          eligible: 47,
          deleted: 0,
          delayedUntil: later + DAY,
        })
        expect(yield* retention.status(new Date(later))).toMatchObject({
          firstRunAt: later + DAY,
          pendingFirstRunCount: 47,
        })

        // The first delay's time no longer deletes anything; the new one does.
        expect(yield* retention.pass(new Date(now + DAY))).toMatchObject({ deleted: 0, delayedUntil: later + DAY })
        expect(yield* retention.pass(new Date(later + DAY))).toMatchObject({ deleted: 47 })
      }),
  )

  it.instance("deletes right away when a lowered period makes 20 or fewer trees newly eligible", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const now = new Date(Date.now() + 40 * DAY)
      const roots = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) => sessions.create({ title: `ten days ${index}` }),
      )
      yield* age(
        roots.map((root) => root.id),
        now.getTime() - 10 * DAY,
      )
      const retention = yield* ready({ now: () => now })
      global.current = Effect.succeed({ cleanupPeriodDays: 7 })

      expect(yield* retention.pass()).toMatchObject({ eligible: 20, deleted: 20 })
    }),
  )

  it.instance("drops a pending delay once raising the period leaves nothing to delete", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const now = new Date(Date.now() + 40 * DAY)
      const roots = yield* Effect.forEach(
        Array.from({ length: 21 }, (_, index) => index),
        (index) => sessions.create({ title: `ten days ${index}` }),
      )
      yield* age(
        roots.map((root) => root.id),
        now.getTime() - 10 * DAY,
      )
      const retention = yield* ready({ now: () => now })
      global.current = Effect.succeed({ cleanupPeriodDays: 7 })
      expect(yield* retention.pass()).toMatchObject({ delayedUntil: now.getTime() + DAY })

      global.current = Effect.succeed({ cleanupPeriodDays: 30 })
      expect(yield* retention.pass()).toMatchObject({ eligible: 0 })
      expect(yield* retention.status()).not.toHaveProperty("firstRunAt")
    }),
  )
})
