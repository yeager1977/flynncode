import { describe, expect } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Memory } from "../../src/memory/memory"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { TestConfig } from "../fixture/config"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

function memoryLayer(memory: unknown, global: Partial<Global.Interface>) {
  return AppNodeBuilder.build(Memory.node, [
    [
      Config.node,
      Layer.succeed(
        Config.Service,
        TestConfig.make({ get: () => Effect.succeed({ memory }) as Effect.Effect<never> as never }),
      ),
    ],
    [Global.node, Global.layerWith(global)],
  ])
}

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

describe("Memory", () => {
  it.live("disabled by default lists nothing", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const svc = yield* Memory.Service
        const list = yield* svc.list()
        expect(list.length).toBe(0)
      }).pipe(Effect.provide(memoryLayer(undefined, { home: dir, config: dir, data: dir }))),
    ),
  )

  it.live("loads project memories sorted with redaction", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const memdir = path.join(dir, ".opencode", "memories")
        yield* fs.makeDirectory(memdir, { recursive: true })
        yield* write(path.join(memdir, "b.md"), "token ghp_abcdefghij1234567890")
        yield* write(path.join(memdir, "a.md"), "Prefer bun over npm.")
        const svc = yield* Memory.Service
        const loaded = yield* svc.load()
        expect(loaded.length).toBe(2)
        expect(loaded[0].filepath.endsWith("a.md")).toBe(true)
        expect(loaded[1].content).toContain("[redacted:github]")
      }).pipe(Effect.provide(memoryLayer({ enabled: true }, { home: dir, config: dir, data: dir }))),
    ),
  )

  it.live("append sanitizes traversal and redacts", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const svc = yield* Memory.Service
        const projectDir = yield* svc.projectDir()
        const target = yield* svc.append({
          scope: "project",
          filename: "../evil.md",
          text: "token ghp_abcdefghij1234567890",
        })
        expect(target.startsWith(projectDir)).toBe(true)
        expect(target).not.toContain("..")
        const fs = yield* FileSystem.FileSystem
        const body = yield* fs.readFileString(target)
        expect(body).toContain("[redacted:github]")
      }).pipe(Effect.provide(memoryLayer({ enabled: true }, { home: dir, config: dir, data: dir }))),
    ),
  )
})

export { tmpdirScoped }
