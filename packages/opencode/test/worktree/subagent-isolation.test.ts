import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { FSUtil } from "@flynncode/core/fs-util"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Git } from "../../src/git"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Worktree } from "../../src/worktree/index"
import { shouldDispose } from "../../src/worktree/session-binding"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)

describe("subagent isolation cleanup", () => {
  afterEach(() => disposeAllInstances())

  it.effect("worktree service exposes disposable create and idle dispose", () =>
    Effect.gen(function* () {
      const svc = yield* Worktree.Service
      expect(typeof svc.createDisposable).toBe("function")
      expect(typeof svc.disposeIfIdle).toBe("function")
    }),
  )

  it.instance(
    "disposable worktree is created under the session slug and disposed when idle",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const store = yield* InstanceStore.Service

        // createDisposable forks the instance bootstrap; listen before creating
        // so a fast Ready event is not missed.
        const ready = yield* Deferred.make<void>()
        const on = (event: GlobalEvent) => {
          if (event.payload.type === Worktree.Event.Ready.type) Deferred.doneUnsafe(ready, Effect.void)
        }
        GlobalBus.on("event", on)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

        const info = yield* svc.createDisposable({ sessionID: "ses_child" })
        expect(info.branch).toMatch(/^opencode\/session-ses-child/)
        expect(info.directory).toContain("session-ses-child")

        // The serving instance's own worktree is never disposed.
        expect(yield* svc.disposeIfIdle({ directory: test.directory })).toBe(false)

        // Wait for the forked bootstrap to load the worktree instance, then
        // dispose it. Disposing earlier races the load: under load the instance
        // appears after disposeDirectory and the idle check sees it running.
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
          }),
        )
        yield* store.disposeDirectory(info.directory).pipe(Effect.ignore)
        expect(yield* svc.disposeIfIdle({ directory: info.directory })).toBe(true)
      }),
    { git: true },
  )

  test("disposable temp worktree is removed only when archived and idle", () => {
    const binding = { sessionID: "ses_child", directory: "/repo/.opencode/worktrees/ses-child", disposable: true }
    expect(shouldDispose(binding, { archived: true, running: false })).toBe(true)
    expect(shouldDispose(binding, { archived: false, running: false })).toBe(false)
  })
})
