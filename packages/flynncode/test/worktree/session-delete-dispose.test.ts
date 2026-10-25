import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { SessionProjector } from "@flynncode/core/session/projector"
import { FSUtil } from "@flynncode/core/fs-util"
import { Effect } from "effect"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Session } from "../../src/session/session"
import { Worktree } from "../../src/worktree"
import { disposeSettledWorktree } from "../../src/worktree/dispose-bound"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Worktree.node, Session.node, SessionProjector.node, Database.node, FSUtil.node, Git.node]),
    [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
  ),
)

const createOwnedWorktree = (name: string) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const gitSvc = yield* Git.Service
    const directory = path.join(test.directory, ".opencode", "worktrees", name)
    const created = yield* gitSvc.run(["worktree", "add", "--no-checkout", "-b", `opencode/${name}`, directory], {
      cwd: test.directory,
    })
    if (created.exitCode !== 0) throw new Error(`git worktree add failed: ${created.stderr.toString("utf8")}`)
    return directory
  })

const bindSession = (sessions: Session.Interface, directory: string, title: string) =>
  Effect.gen(function* () {
    const created = yield* sessions.create({ title })
    yield* sessions.setDirectory({ sessionID: created.id, directory })
    yield* sessions.setMetadata({ sessionID: created.id, metadata: { disposable: true, worktree: directory } })
    // Re-read so the returned info carries the binding, as the handler's pre-delete read does.
    return yield* sessions.get(created.id)
  })

describe("dispose a task worktree when its session is deleted", () => {
  afterEach(() => disposeAllInstances())

  it.instance(
    "removes the worktree when the deleted session was the only one bound to it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("delete-sole")
        const info = yield* bindSession(sessions, directory, "sole")

        yield* sessions.remove(info.id)
        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info })

        expect(removed).toBe(directory)
        expect(yield* fs.exists(directory)).toBe(false)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "keeps the worktree while another bound session is not archived",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("delete-shared")
        const doomed = yield* bindSession(sessions, directory, "doomed")
        yield* bindSession(sessions, directory, "survivor")

        yield* sessions.remove(doomed.id)
        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info: doomed })

        expect(removed).toBeUndefined()
        expect(yield* fs.exists(directory)).toBe(true)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "removes the worktree when every remaining bound session is archived",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("delete-archived-peer")
        const doomed = yield* bindSession(sessions, directory, "doomed")
        const peer = yield* bindSession(sessions, directory, "peer")
        yield* sessions.setArchived({ sessionID: peer.id, time: Date.now() })

        yield* sessions.remove(doomed.id)
        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info: doomed })

        expect(removed).toBe(directory)
        expect(yield* fs.exists(directory)).toBe(false)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "leaves a worktree alone when the deleted session was not bound to a disposable one",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("delete-plain")
        const plain = yield* sessions.create({ title: "plain" })
        yield* sessions.setDirectory({ sessionID: plain.id, directory })
        const info = yield* sessions.get(plain.id)

        yield* sessions.remove(plain.id)
        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info })

        expect(removed).toBeUndefined()
        expect(yield* fs.exists(directory)).toBe(true)
      }),
    { git: true },
    { timeout: 30000 },
  )
})
