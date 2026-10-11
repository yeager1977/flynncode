import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { SessionProjector } from "@flynncode/core/session/projector"
import { SessionTable } from "@flynncode/core/session/sql"
import { FSUtil } from "@flynncode/core/fs-util"
import { and, eq, like } from "drizzle-orm"
import { Effect } from "effect"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Session } from "../../src/session/session"
import { Worktree } from "../../src/worktree"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Worktree.node, Session.node, SessionProjector.node, Database.node, FSUtil.node, Git.node]),
    [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
  ),
)

// Create an owned worktree directly with git. The sweep only needs worktrees
// under the configured location on a prefixed branch; `createDisposable` is
// covered by the live tests in subagent-isolation.test.ts (it forks an
// instance bootstrap, which would add boot timing to these assertions).
const createOwnedWorktree = (input: { name: string }) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const gitSvc = yield* Git.Service
    const directory = path.join(test.directory, ".opencode", "worktrees", input.name)
    const branch = `opencode/${input.name}`
    const created = yield* gitSvc.run(["worktree", "add", "--no-checkout", "-b", branch, directory], {
      cwd: test.directory,
    })
    if (created.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${created.stderr.toString("utf8")}`)
    }
    return { name: input.name, directory }
  })

// Bind a session to a worktree the same way the task tool binds disposable
// ones: the session row directory moves to the worktree and the binding
// travels in metadata.
const bindSession = (input: { sessions: Session.Interface; directory: string; title: string }) =>
  Effect.gen(function* () {
    const session = yield* input.sessions.create({ title: input.title })
    yield* input.sessions.setDirectory({ sessionID: session.id, directory: input.directory })
    yield* input.sessions.setMetadata({
      sessionID: session.id,
      metadata: { disposable: true, worktree: input.directory, pin: input.title },
    })
    return session
  })

// Pin a session's update time directly in the row so recency ordering does
// not hinge on wall-clock spacing between creations. Wait until the projector
// has applied the binding first (the pin marker rides in metadata), so a
// later-published Updated projection cannot overwrite the pinned time.
const ageFromPin = (input: { sessionID: Session.Info["id"]; pin: string; time: number }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* pollWithTimeout(
      db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(and(eq(SessionTable.id, input.sessionID), like(SessionTable.metadata, `%${input.pin}%`)))
        .get()
        .pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
          Effect.map((row) => (row?.metadata ? row : undefined)),
        ),
      `session ${input.sessionID} projection never appeared`,
    )
    yield* db
      .update(SessionTable)
      .set({ time_updated: input.time })
      .where(eq(SessionTable.id, input.sessionID))
      .pipe(Effect.orDie)
  })

describe("Worktree.retention sweep", () => {
  afterEach(() => disposeAllInstances())

  it.instance(
    "sweep retires the oldest disposable worktree past keep and protects the newest and dirty ones",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const svc = yield* Worktree.Service
        const sessions = yield* Session.Service

        const oldest = yield* createOwnedWorktree({ name: "retention-oldest" })
        const newest = yield* createOwnedWorktree({ name: "retention-newest" })
        const dirty = yield* createOwnedWorktree({ name: "retention-dirty" })

        const oldestSession = yield* bindSession({
          sessions,
          directory: oldest.directory,
          title: "oldest",
        })
        const newestSession = yield* bindSession({
          sessions,
          directory: newest.directory,
          title: "newest",
        })
        const dirtySession = yield* bindSession({
          sessions,
          directory: dirty.directory,
          title: "dirty",
        })
        const now = Date.now()
        yield* ageFromPin({ sessionID: oldestSession.id, pin: "oldest", time: now - 10_000_000 })
        yield* ageFromPin({ sessionID: newestSession.id, pin: "newest", time: now - 1_000 })
        yield* ageFromPin({ sessionID: dirtySession.id, pin: "dirty", time: now - 5_000_000 })

        // An untracked file makes git status never clean: the non-destructive
        // retire path must keep this worktree even when it is a keep-N loser.
        yield* Effect.promise(() => Bun.write(path.join(dirty.directory, "untracked.txt"), "dirty"))

        yield* svc.retire

        const remaining = yield* svc.list()
        const names = remaining.map((entry) => entry.name)
        // Enrichment makes lastUsedAt (session recency) win over mtime: the
        // newest session's worktree survives keep=1 even though the dirty one
        // was created last with the freshest mtime.
        expect(names).toContain(newest.name)
        expect(names).toContain(dirty.name)
        expect(names).not.toContain(oldest.name)
        expect(yield* fs.exists(newest.directory)).toBe(true)
        expect(yield* fs.exists(dirty.directory)).toBe(true)
        expect(yield* fs.exists(oldest.directory)).toBe(false)
        // A swept worktree is fully gone; remove() still reports success.
        expect(yield* svc.remove({ directory: oldest.directory })).toBe(true)
      }),
    { git: true, config: { worktree: { keep: 1 } } },
    { timeout: 30000 },
  )

  it.instance(
    "retire keeps entries with no bound sessions when nothing is past keep",
    () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const worktree = yield* createOwnedWorktree({ name: "retention-unbound" })
        yield* svc.retire
        const remaining = yield* svc.list()
        // keep default is 15: nothing past the limit, so the unbound
        // worktree stays.
        expect(remaining.map((entry) => entry.name)).toContain(worktree.name)
      }),
    { git: true },
    { timeout: 30000 },
  )
})