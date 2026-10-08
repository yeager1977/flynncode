import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
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

        const info = yield* svc.createDisposable({ sessionID: "ses_child" })
        expect(info.branch).toMatch(/^opencode\/session-ses-child/)
        expect(info.directory).toContain("session-ses-child")

        // The serving instance's own worktree is never disposed.
        expect(yield* svc.disposeIfIdle({ directory: test.directory })).toBe(false)

        // Drain the async bootstrap load so the idle check is deterministic.
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
