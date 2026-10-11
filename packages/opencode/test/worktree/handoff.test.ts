import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { FSUtil } from "@flynncode/core/fs-util"
import { Cause, Effect, Exit, Fiber } from "effect"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)
const wintest = process.platform !== "win32" ? it.instance : it.instance.skip

const failOf = (effect: Effect.Effect<unknown, Worktree.Error>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (!Exit.isFailure(exit)) throw new Error("expected handoff to fail")
    return Cause.squash(exit.cause) as Worktree.Error
  })

const git = Effect.fn("HandoffTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})

describe("Worktree.handoff", () => {
  afterEach(() => disposeAllInstances())

  it.instance(
    "rejects identical source and destination paths",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const error = yield* failOf(svc.handoff({ from: test.directory, to: test.directory }))
        expect(error instanceof Worktree.HandoffFailedError).toBe(true)
      }),
    { git: true },
  )

  wintest(
    "rejects an unknown source worktree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const destination = path.join(test.directory, "destination")

        const error = yield* failOf(
          svc.handoff({ from: path.join(test.directory, "missing-worktree"), to: destination }),
        )

        expect(error instanceof Worktree.HandoffFailedError).toBe(true)
      }),
    { git: true },
  )

  wintest(
    "rejects a missing destination instead of creating it",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const name = `handoff-src-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const source = path.join(test.directory, name)

        yield* git(test.directory, ["worktree", "add", "--no-checkout", "-b", branch, source])
        yield* git(source, ["reset", "--hard"])

        const error = yield* failOf(svc.handoff({ from: source, to: path.join(test.directory, "never-created") }))
        expect(error instanceof Worktree.HandoffFailedError).toBe(true)

        yield* svc.remove({ directory: source })
      }),
    { git: true },
  )

  wintest(
    "carries session-relevant state from source to destination",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fsMod = yield* FSUtil.Service
        const svc = yield* Worktree.Service
        const name = `handoff-src-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const source = path.join(test.directory, name)
        const destination = path.join(test.directory, "handoff-destination")

        yield* git(test.directory, ["worktree", "add", "--no-checkout", "-b", branch, source])
        yield* git(source, ["reset", "--hard"])
        yield* git(test.directory, ["worktree", "add", "--no-checkout", "--detach", destination, "HEAD"])
        yield* git(destination, ["reset", "--hard"])

        const seeded = path.join(source, "handoff-source.txt")
        yield* Effect.promise(() => Bun.write(seeded, "carried"))

        const ok = yield* svc.handoff({ from: source, to: destination })

        expect(ok).toBe(true)
        const carried = path.join(destination, "handoff-source.txt")
        expect(yield* fsMod.exists(carried)).toBe(true)
        expect(yield* fsMod.readFileString(carried)).toBe("carried")
        expect(yield* fsMod.exists(path.join(destination, ".git"))).toBe(true)

        yield* svc.remove({ directory: source })
        yield* svc.remove({ directory: destination })
      }),
    { git: true },
  )

  wintest(
    "skips deleted files instead of crashing the handoff",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fsMod = yield* FSUtil.Service
        const svc = yield* Worktree.Service
        const name = `handoff-del-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const source = path.join(test.directory, name)
        const destination = path.join(test.directory, "handoff-deleted-destination")

        yield* git(test.directory, ["worktree", "add", "--no-checkout", "-b", branch, source])
        yield* git(source, ["reset", "--hard"])
        yield* git(test.directory, ["worktree", "add", "--no-checkout", "--detach", destination, "HEAD"])
        yield* git(destination, ["reset", "--hard"])

        // A tracked file deleted in the worktree (unstaged) and one with a
        // staged deletion both enumerate in `git status -z`; neither has a
        // source to copy.
        yield* Effect.promise(() => Bun.write(path.join(source, "tracked.txt"), "tracked"))
        yield* git(source, ["add", "tracked.txt"])
        yield* git(source, ["commit", "-m", "seed tracked file"])
        yield* Effect.promise(() => Bun.file(path.join(source, "tracked.txt")).unlink())

        yield* Effect.promise(() => Bun.write(path.join(source, "staged-deleted.txt"), "staged"))
        yield* git(source, ["add", "staged-deleted.txt"])
        yield* git(source, ["commit", "-m", "seed staged deletion"])
        yield* git(source, ["rm", "staged-deleted.txt"])

        // A live uncommitted file must still be carried alongside the deletions.
        yield* Effect.promise(() => Bun.write(path.join(source, "kept.txt"), "kept"))

        const ok = yield* svc.handoff({ from: source, to: destination })

        expect(ok).toBe(true)
        expect(yield* fsMod.exists(path.join(destination, "kept.txt"))).toBe(true)
        expect(yield* fsMod.exists(path.join(destination, "tracked.txt"))).toBe(false)
        expect(yield* fsMod.exists(path.join(destination, "staged-deleted.txt"))).toBe(false)

        yield* svc.remove({ directory: source })
        yield* svc.remove({ directory: destination })
      }),
    { git: true },
  )
})
