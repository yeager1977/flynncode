import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { inArray, sql } from "drizzle-orm"
import { Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { FSUtil } from "@flynncode/core/fs-util"
import { Database } from "@flynncode/core/database/database"
import { MessageTable, PartTable, SessionTable, SessionTombstoneTable } from "@flynncode/core/session/sql"
import { SessionProjector } from "@flynncode/core/session/projector"
import { ConfigV1 } from "@flynncode/core/v1/config/config"
import { InvalidError } from "@flynncode/core/v1/config/error"
import type { SessionV1 } from "@flynncode/core/v1/session"
import { SessionRetention as RetentionSchema } from "@flynncode/schema/session-retention"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { ScheduleStore } from "@/schedule/store"
import { SessionRetention } from "@/session/retention/service"
import { SessionRetentionQuery } from "@/session/retention/query"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { BackgroundShells } from "@/shell/background/service"
import { Worktree } from "@/worktree"
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
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
      [Config.node, TestConfig.layer({ getGlobal: () => Effect.suspend(() => global.current) })],
    ],
  ),
)

afterEach(async () => {
  global.current = Effect.succeed({})
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

// A retention instance whose first run already happened, so passes delete right away.
const ready = Effect.fnUntraced(function* (input: { now: () => Date; lock?: string }) {
  const state = yield* statePath
  yield* Effect.promise(() => Bun.write(state, JSON.stringify({ completedAt: 0 })))
  return yield* SessionRetention.make({ now: input.now, statePath: state, lock: input.lock })
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

  it.instance("never deletes while the config is invalid", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "invalid config" })
      global.current = Effect.die(new InvalidError({ path: "opencode.jsonc", issues: [] }))
      const retention = yield* ready({ now: () => new Date(Date.now() + 400 * DAY) })

      expect(Exit.isFailure(yield* retention.pass().pipe(Effect.exit))).toBe(true)
      expect(yield* remaining([root.id])).toEqual([root.id])
    }),
  )

  it.instance("deletes through the manual-delete path, leaving tombstones, and announces the pass", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const stale = yield* tree("tombstoned")
      const retention = yield* ready({ now: () => new Date(Date.now() + 40 * DAY) })
      const event = yield* waitGlobalBusEvent({
        predicate: (item) => item.payload.type === RetentionSchema.Event.Updated.type,
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      yield* retention.pass()

      const tombstones = yield* db
        .select({ id: SessionTombstoneTable.id })
        .from(SessionTombstoneTable)
        .where(inArray(SessionTombstoneTable.id, stale.ids))
        .all()
        .pipe(Effect.orDie)
      expect(tombstones.map((row) => row.id).sort()).toEqual([...stale.ids].sort())
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
      expect(details.some((detail) => /SCAN (message|part|session_message)\b/.test(detail))).toBe(false)
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
