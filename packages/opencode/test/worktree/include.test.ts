import { $ } from "bun"
import { describe, expect } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber } from "effect"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Worktree.node, [[InstanceStore.bootstrapNode, InstanceBootstrap.node]]))

const waitReady = Effect.fn("WorktreeTest.waitReady")(function* () {
  const ready = yield* Deferred.make<{ name: string; branch?: string }>()
  const on = (evt: GlobalEvent) => {
    if (evt.payload.type !== Worktree.Event.Ready.type) return
    Deferred.doneUnsafe(ready, Effect.succeed(evt.payload.properties))
  }
  GlobalBus.on("event", on)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))
  return yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")) }),
  )
})

const withCreatedWorktree = (input?: Parameters<Worktree.Interface["create"]>[0]) =>
  Effect.gen(function* () {
    const svc = yield* Worktree.Service
    const ready = yield* waitReady().pipe(Effect.forkScoped)
    const info = yield* svc.create(input)
    yield* Fiber.join(ready)
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const s = yield* Worktree.Service
        yield* s.remove({ directory: info.directory }).pipe(Effect.catch(() => Effect.void))
      }),
    )
    return info
  })

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

describe("Worktree .worktreeinclude carry", () => {
  it.instance(
    "copies a gitignored file listed in .worktreeinclude into the new worktree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(test.directory, ".gitignore"), ".env\n"))
        yield* Effect.promise(() => Bun.write(path.join(test.directory, ".env"), "SECRET=1\n"))
        yield* Effect.promise(() => Bun.write(path.join(test.directory, ".worktreeinclude"), "# secrets\n.env\n"))
        yield* Effect.promise(() => $`git add .gitignore .worktreeinclude`.cwd(test.directory).quiet())
        yield* Effect.promise(() => $`git commit -m manifest`.cwd(test.directory).quiet())

        const info = yield* withCreatedWorktree({ name: "carry-env" })
        // The carry runs before boot; by worktree.ready the file is on disk.
        const carried = yield* read(path.join(info.directory, ".env"))
        expect(carried.trim()).toBe("SECRET=1")
      }),
    { git: true },
  )

  it.instance(
    "does not carry a tracked file named in .worktreeinclude",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "tracked.txt"), "tracked\n"))
        yield* Effect.promise(() => Bun.write(path.join(test.directory, ".worktreeinclude"), "tracked.txt\n"))
        yield* Effect.promise(() => $`git add tracked.txt .worktreeinclude`.cwd(test.directory).quiet())
        yield* Effect.promise(() => $`git commit -m tracked`.cwd(test.directory).quiet())

        const info = yield* withCreatedWorktree({ name: "skip-tracked" })
        // The file exists via checkout, not via carry: the worktree stays clean
        // after boot, confirming nothing extra landed.
        const worktreeCopy = yield* read(path.join(info.directory, "tracked.txt"))
        expect(worktreeCopy.trim()).toBe("tracked")
        const status = yield* Effect.promise(() => $`git status --porcelain`.cwd(info.directory).quiet().text())
        expect(status.trim()).toBe("")
      }),
    { git: true },
  )
})