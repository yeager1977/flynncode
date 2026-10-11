import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { HooksRunner } from "@/hooks/runner"
import { Memory } from "@/memory/memory"
import { Permission } from "@/permission"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "../../src/session/schema"
import { MemoryTool } from "../../src/tool/memory"
import * as Tool from "../../src/tool/tool"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testLayerWithHooks } from "../lib/hooks"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"

afterEach(async () => {
  await disposeAllInstances()
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const passthroughHooks = testLayerWithHooks([])

const testConfigLayer = (memory: unknown) =>
  Layer.succeed(
    Config.Service,
    TestConfig.make({
      directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
      get: () => Effect.succeed({ memory }) as Effect.Effect<never> as never,
    }),
  )

// Full stack for tool-level tests: Memory plus Tool.define's dependencies
// (Agent, Truncate), with the real Permission service so ask/reply mechanics run
// for real in the sticky-approval test.
const nodeLayer = (memory: unknown, global: Partial<Global.Interface>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Memory.node,
      Agent.node,
      Truncate.node,
      Permission.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      LayerNodePlatform.filesystem,
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [HooksRunner.node, passthroughHooks],
      [Config.node, testConfigLayer(memory)],
      [Global.node, Global.layerWith(global)],
    ],
  )

// Base runtime for it.live/it.instance; tool tests layer their own services on
// top via Effect.provide.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([CrossSpawnSpawner.node, InstanceStore.node, LayerNodePlatform.filesystem]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [HooksRunner.node, passthroughHooks],
    ],
  ),
)

type AskRequest = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

const ctx = (sessionID: SessionID, handle?: (req: AskRequest) => Effect.Effect<void>) =>
  ({
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (req: AskRequest) => handle?.(req) ?? Effect.void,
  }) as unknown as Tool.Context

// ctx.ask bridges to the real Permission service so pending asks can be
// answered through `permission.reply`.
const permissionCtx = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    // Replies in this test are always accepted, so any PermissionV1 error is a
    // defect rather than an expected outcome.
    return ctx(sessionID, (req) =>
      permission.ask({ sessionID, ruleset: [], ...req, metadata: req.metadata }).pipe(Effect.orDie),
    )
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

const replyAlways = (requestID: PermissionV1.ID | undefined, reply: PermissionV1.Reply) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    if (!requestID) throw new Error("no pending permission request")
    yield* permission.reply({ requestID, reply })
  })

const enabledLayer = (dir: string) => nodeLayer({ enabled: true }, { home: dir, config: dir, data: dir })

describe("tool.memory", () => {
  it.live("save stores a memory visible in list", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("ses_memory")
        const memory = yield* Memory.Service
        const info = yield* MemoryTool
        const def = yield* Tool.init(info)
        const asks: AskRequest[] = []
        const testCtx = ctx(sessionID, (req) =>
          Effect.sync(() => {
            asks.push(req)
          }),
        )

        const result = yield* def.execute(
          { action: "save", scope: "project", slug: "test-runner", text: "always use bun" },
          testCtx,
        )
        const found = yield* memory.listDetailed()
        expect(found.length).toBe(1)
        expect(found[0].scope).toBe("project")
        expect(found[0].filepath).toContain("test-runner.md")
        expect(result.output).toContain("test-runner.md")
        expect(asks.length).toBe(1)
        expect(asks[0].permission).toBe("memory")
        expect(asks[0].patterns).toEqual(["project"])
        expect(asks[0].always).toEqual(["project"])
      }).pipe(Effect.provide(enabledLayer(dir))),
    ),
  )

  it.live("redaction is enforced before the memory is written", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("ses_memory")
        const info = yield* MemoryTool
        const def = yield* Tool.init(info)
        yield* def.execute(
          { action: "save", scope: "global", slug: "leaky", text: "my token ghp_abcdefghij1234567890 for CI" },
          ctx(sessionID),
        )
        const memory = yield* Memory.Service
        const found = yield* memory.listDetailed()
        if (!found[0]) throw new Error("memory was not saved")
        const body = yield* Effect.promise(() => Bun.file(found[0].filepath).text())
        expect(body).toContain("[redacted:github]")
        expect(body).not.toContain("ghp_abcdefghij1234567890")
      }).pipe(Effect.provide(enabledLayer(dir))),
    ),
  )

  it.live("ask gate fires once then always sticks for the scope", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("ses_memory")
        const info = yield* MemoryTool
        const def = yield* Tool.init(info)
        const testCtx = yield* permissionCtx(sessionID)
        const save = (slug: string) =>
          def.execute({ action: "save", scope: "global", slug, text: `convention about ${slug}` }, testCtx)

        // First save prompts; approving with "always" stores a scope-wide rule.
        const fiber = yield* save("first").pipe(Effect.forkScoped)
        const pending = yield* waitForPending(1)
        yield* replyAlways(pending[0]?.id, "always")
        yield* Fiber.join(fiber)

        // Same scope, different slug: no second prompt.
        yield* save("second")
        const permission = yield* Permission.Service
        expect(yield* permission.list()).toEqual([])

        // A different scope still prompts.
        const other = yield* def
          .execute({ action: "save", scope: "project", slug: "other", text: "project convention" }, testCtx)
          .pipe(Effect.forkScoped)
        const projectPending = yield* waitForPending(1)
        yield* replyAlways(projectPending[0]?.id, "once")
        yield* Fiber.join(other)
      }).pipe(Effect.provide(enabledLayer(dir))),
    ),
  )

  it.live("remove deletes a saved memory", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("ses_memory")
        const memory = yield* Memory.Service
        const info = yield* MemoryTool
        const def = yield* Tool.init(info)
        const testCtx = ctx(sessionID)

        yield* def.execute({ action: "save", scope: "project", slug: "tmp-key", text: "temporary note" }, testCtx)
        expect((yield* memory.listDetailed()).length).toBe(1)
        const removed = yield* def.execute({ action: "remove", scope: "project", slug: "tmp-key" }, testCtx)
        expect(yield* memory.listDetailed()).toEqual([])
        expect(removed.output).toContain("tmp-key")
        const missing = yield* def.execute({ action: "remove", scope: "project", slug: "tmp-key" }, testCtx)
        expect(missing.output).toContain("No memory")
      }).pipe(Effect.provide(enabledLayer(dir))),
    ),
  )

  it.live("list works without asking and validates save arguments", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("ses_memory")
        const info = yield* MemoryTool
        const def = yield* Tool.init(info)
        const asks: AskRequest[] = []
        const testCtx = ctx(sessionID, (req) =>
          Effect.sync(() => {
            asks.push(req)
          }),
        )

        const listing = yield* def.execute({ action: "list" }, testCtx)
        expect(listing.output).toContain("No memories saved")
        expect(asks).toEqual([])

        const noSlug = yield* def
          .execute({ action: "save", scope: "project", text: "no slug" }, testCtx)
          .pipe(Effect.exit)
        expect(Exit.isFailure(noSlug)).toBe(true)
        const noText = yield* def
          .execute({ action: "save", scope: "project", slug: "no-text" }, testCtx)
          .pipe(Effect.exit)
        expect(Exit.isFailure(noText)).toBe(true)
        const noScope = yield* def.execute({ action: "remove", slug: "x" }, testCtx).pipe(Effect.exit)
        expect(Exit.isFailure(noScope)).toBe(true)
        expect(asks).toEqual([])
      }).pipe(Effect.provide(enabledLayer(dir))),
    ),
  )
})

describe("tool.registry memory gating", () => {
  const root = LayerNode.group([ToolRegistry.node])
  const bootstrap = [
    InstanceStore.bootstrapNode,
    Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
  ] as const
  const env = (memory: unknown) =>
    testEffect(
      LayerNode.compile(root, [
        bootstrap,
        [Config.node, testConfigLayer(memory)],
        [RuntimeFlags.node, RuntimeFlags.layer()],
      ]),
    )

  const defaultEnv = env(undefined)
  const enabledEnv = env({ enabled: true })

  defaultEnv.instance("hides the memory tool by default", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("memory")
    }),
  )

  enabledEnv.instance("exposes the memory tool when memory config is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("memory")
    }),
  )
})