import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Memory } from "../../src/memory/memory"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { TestConfig } from "../fixture/config"
import { provideTmpdirInstance } from "../fixture/fixture"
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

function memoryLayer(global: Partial<Global.Interface>) {
  return AppNodeBuilder.build(Memory.node, [
    [
      Config.node,
      Layer.succeed(
        Config.Service,
        TestConfig.make({ get: () => Effect.succeed({ memory: { enabled: true } }) as never }),
      ),
    ],
    [Global.node, Global.layerWith(global)],
  ])
}

describe("Memory never-synced guarantees", () => {
  it.live("global dir lives under XDG data dir, project dir under .opencode, load redacts", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const svc = yield* Memory.Service
        const globalDir = yield* svc.globalDir()
        const projectDir = yield* svc.projectDir()
        expect(globalDir.startsWith(`${dir}-data`)).toBe(true)
        expect(globalDir.startsWith(dir + "/")).toBe(false)
        expect(projectDir.endsWith(".opencode/memories")).toBe(true)
        yield* svc.append({
          scope: "project",
          filename: "note.md",
          text: "deploy token ghp_abcdefghij1234567890 and slack xoxb-123456789012-abcdefghij123456",
        })
        const loaded = yield* svc.load()
        const body = loaded.map((item) => item.content).join("\n")
        expect(body).toContain("[redacted:")
        expect(body).not.toContain("ghp_abcdefghij1234567890")
        expect(body).not.toContain("xoxb-123456789012-abcdefghij123456")
      }).pipe(
        Effect.provide(
          memoryLayer({ home: dir, config: `${dir}-config`, data: `${dir}-data` }),
        ),
      ),
    ),
  )
})
