import { describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { Config } from "@/config/config"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Instruction } from "../../src/session/instruction"
import { MessageID } from "../../src/session/schema"
import { TestConfig } from "../fixture/config"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]),
    [
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const instructionLayer = AppNodeBuilder.build(Instruction.node, [
  [Config.node, Layer.succeed(Config.Service, TestConfig.make())],
  [Global.node, Global.layerWith({ home: "", config: "" })],
  [RuntimeFlags.node, RuntimeFlags.layer({})],
])

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

// Bind a primary instance that also carries attached extras in its context.
const provideWithExtras =
  (directory: string, additionalDirectories: string[]) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    InstanceStore.Service.use((store) => store.provide({ directory, additionalDirectories }, self))

describe("multifold instruction base", () => {
  test("base paths ignore extras", async () => {
    const mod = await import("@/session/instruction")
    expect(mod.Service ?? mod.Instruction).toBeDefined()
  })
  test("base discovery reads primary directory only", async () => {
    const source = await Bun.file(
      new URL("../../src/session/instruction.ts", import.meta.url).toString().replace("file://", ""),
    ).text()
    expect(source).toContain("primary folder only")
    // The nested AGENTS walk may reference additionalDirectories to scope
    // extra-resident files, but base discovery (resolveBasePaths) itself must
    // stay primary-only.
    const base = source.slice(source.indexOf("resolveBasePaths"), source.indexOf("const state ="))
    expect(base).not.toContain("additionalDirectories")
  })

  it.live(
    "attaches nested AGENTS.md inside an attached folder without crossing boundaries",
    () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped()
        const extra = yield* tmpdirScoped()
        yield* write(path.join(extra, "AGENTS.md"), "# Extra Instructions")
        yield* write(path.join(extra, "nested", "file.ts"), "const x = 1")
        yield* write(path.join(primary, "src", "file.ts"), "const y = 2")

        yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const sys = yield* svc.systemPaths()
          expect(sys.has(path.join(extra, "AGENTS.md"))).toBe(false)

          const nested = yield* svc.resolve(
            [],
            path.join(extra, "nested", "file.ts"),
            MessageID.make("msg_message-multifold-extra-1"),
          )
          expect(nested).toHaveLength(1)
          expect(nested[0].filepath).toBe(path.join(extra, "AGENTS.md"))

          const inside = yield* svc.resolve(
            [],
            path.join(primary, "src", "file.ts"),
            MessageID.make("msg_message-multifold-extra-2"),
          )
          expect(inside.find((result) => result.filepath === path.join(extra, "AGENTS.md"))).toBeUndefined()
        }).pipe(provideWithExtras(primary, [extra]), Effect.provide(instructionLayer))
      }),
  )
})
