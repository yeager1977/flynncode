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

// A checked-out task worktree on its own branch, like createDisposable makes.
const createOwnedWorktree = (name: string) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const gitSvc = yield* Git.Service
    const directory = path.join(test.directory, ".opencode", "worktrees", name)
    const created = yield* gitSvc.run(["worktree", "add", "-b", `opencode/${name}`, directory], {
      cwd: test.directory,
    })
    if (created.exitCode !== 0) throw new Error(`git worktree add failed: ${created.stderr.toString("utf8")}`)
    return directory
  })

const git = (args: string[], cwd: string) =>
  Effect.gen(function* () {
    const gitSvc = yield* Git.Service
    const result = yield* gitSvc.run(args, { cwd })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
    return result.stdout.toString("utf8").trim()
  })

const branchExists = (name: string) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const gitSvc = yield* Git.Service
    const result = yield* gitSvc.run(["rev-parse", "--verify", "--quiet", `refs/heads/opencode/${name}`], {
      cwd: test.directory,
    })
    return result.exitCode === 0
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
        // The task branch is never deleted by disposal.
        expect(yield* branchExists("delete-sole")).toBe(true)
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
        expect(yield* branchExists("delete-archived-peer")).toBe(true)
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

// Disposal never loses work: the folder goes only when it is clean and every
// commit on it is reachable elsewhere, and the branch always stays.
describe("dispose a task worktree only when nothing is lost", () => {
  afterEach(() => disposeAllInstances())

  it.instance(
    "archive removes a clean worktree with no unique commits and keeps its branch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("archive-clean")
        const info = yield* bindSession(sessions, directory, "clean")
        yield* sessions.setArchived({ sessionID: info.id, time: Date.now() })

        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info: yield* sessions.get(info.id) })

        expect(removed).toBe(directory)
        expect(yield* fs.exists(directory)).toBe(false)
        expect(yield* branchExists("archive-clean")).toBe(true)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "archive keeps a worktree with an uncommitted file and its branch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("archive-dirty")
        yield* Effect.promise(() => Bun.write(path.join(directory, "notes.txt"), "work in progress\n"))
        const info = yield* bindSession(sessions, directory, "dirty")
        yield* sessions.setArchived({ sessionID: info.id, time: Date.now() })

        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info: yield* sessions.get(info.id) })

        expect(removed).toBeUndefined()
        expect(yield* fs.exists(path.join(directory, "notes.txt"))).toBe(true)
        expect(yield* branchExists("archive-dirty")).toBe(true)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "delete keeps a worktree with an uncommitted file and its branch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("delete-dirty")
        yield* Effect.promise(() => Bun.write(path.join(directory, "notes.txt"), "work in progress\n"))
        const info = yield* bindSession(sessions, directory, "dirty")

        yield* sessions.remove(info.id)
        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info })

        expect(removed).toBeUndefined()
        expect(yield* fs.exists(path.join(directory, "notes.txt"))).toBe(true)
        expect(yield* branchExists("delete-dirty")).toBe(true)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "delete keeps a worktree whose branch holds an unmerged commit, and its branch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("delete-unmerged")
        yield* git(["commit", "--allow-empty", "-m", "unmerged task work"], directory)
        const info = yield* bindSession(sessions, directory, "unmerged")

        yield* sessions.remove(info.id)
        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info })

        expect(removed).toBeUndefined()
        expect(yield* fs.exists(directory)).toBe(true)
        expect(yield* branchExists("delete-unmerged")).toBe(true)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "archive keeps a worktree whose branch holds an unmerged commit, and its branch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("archive-unmerged")
        yield* git(["commit", "--allow-empty", "-m", "unmerged task work"], directory)
        const info = yield* bindSession(sessions, directory, "unmerged")
        yield* sessions.setArchived({ sessionID: info.id, time: Date.now() })

        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info: yield* sessions.get(info.id) })

        expect(removed).toBeUndefined()
        expect(yield* fs.exists(directory)).toBe(true)
        expect(yield* branchExists("archive-unmerged")).toBe(true)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "keeps a worktree holding an ignored local file that tooling cannot rebuild",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        yield* Effect.promise(() => Bun.write(path.join(test.directory, ".gitignore"), ".env\n.opencode/\n"))
        yield* git(["add", ".gitignore"], test.directory)
        yield* git(["commit", "-m", "ignore env"], test.directory)
        const directory = yield* createOwnedWorktree("delete-ignored")
        yield* Effect.promise(() => Bun.write(path.join(directory, ".env"), "SECRET=local\n"))
        const info = yield* bindSession(sessions, directory, "ignored")

        yield* sessions.remove(info.id)
        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info })

        expect(removed).toBeUndefined()
        expect(yield* fs.exists(path.join(directory, ".env"))).toBe(true)
        expect(yield* branchExists("delete-ignored")).toBe(true)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "archive removes a worktree whose commit another local branch reaches, and keeps its branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("archive-reachable")
        // Neither merged into the default branch nor pushed, so only the
        // rev-list fallback can find the commit on another branch.
        yield* git(["commit", "--allow-empty", "-m", "task work"], directory)
        yield* git(["branch", "keeper", "opencode/archive-reachable"], test.directory)
        const info = yield* bindSession(sessions, directory, "reachable")
        yield* sessions.setArchived({ sessionID: info.id, time: Date.now() })

        const removed = yield* disposeSettledWorktree({ sessions, worktrees, info: yield* sessions.get(info.id) })

        expect(removed).toBe(directory)
        expect(yield* fs.exists(directory)).toBe(false)
        expect(yield* branchExists("archive-reachable")).toBe(true)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "keeps a worktree with an unmerged commit when a tag shares its branch name",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const worktrees = yield* Worktree.Service
        const directory = yield* createOwnedWorktree("tag-shadow")
        // The tag sits on the base commit, so only the branch reaches the new
        // commit; an ambiguous short name (heads/...) must not exclude the
        // wrong ref and count the branch itself as "elsewhere".
        yield* git(["tag", "opencode/tag-shadow", "HEAD"], test.directory)
        yield* git(["commit", "--allow-empty", "-m", "unmerged task work"], directory)

        expect(yield* worktrees.disposeIfSafe({ directory })).toBe(false)
        expect(yield* fs.exists(directory)).toBe(true)
        expect(yield* branchExists("tag-shadow")).toBe(true)
      }),
    { git: true },
    { timeout: 30000 },
  )
})
