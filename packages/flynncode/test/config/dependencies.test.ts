import { expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Npm } from "@flynncode/core/npm"
import { FSUtil } from "@flynncode/core/fs-util"
import { ConfigDependencies } from "@/config/dependencies"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Npm.node, FSUtil.node, CrossSpawnSpawner.node])))

it.live(
  "installs an upstream-compatible plugin API while preserving third-party config dependencies",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        await Bun.write(path.join(dir, ".npmrc"), "registry=https://registry.npmjs.org/\naudit=false\n")
        await Bun.write(
          path.join(dir, "vendor/fixture/package.json"),
          '{"name":"fixture","version":"1.0.0","main":"index.js"}',
        )
        await Bun.write(path.join(dir, "vendor/fixture/index.js"), "exports.value = 42")
        await Bun.write(
          path.join(dir, "package.json"),
          JSON.stringify({
            name: "config-fixture",
            private: true,
            dependencies: { fixture: "file:./vendor/fixture" },
          }),
        )
      })
      const install = yield* ConfigDependencies.make
      yield* install(dir)
      yield* Effect.promise(async () => {
        const manifest = await Bun.file(path.join(dir, "package.json")).json()
        expect(manifest.dependencies.fixture).toBe("file:./vendor/fixture")
        expect(manifest.dependencies["@flynncode/plugin"]).toBeUndefined()
        const api = await import(pathToFileURL(path.join(dir, "node_modules/@opencode-ai/plugin/dist/tool.js")).href)
        const definition = api.tool({
          description: "fixture",
          args: { value: api.tool.schema.string() },
          execute: async (args: { value: string }) => args.value,
        })
        expect(await definition.execute({ value: "compatible" })).toBe("compatible")
        expect((await import(pathToFileURL(path.join(dir, "node_modules/fixture/index.js")).href)).value).toBe(42)
      })
    }),
  { timeout: 60_000 },
)

it.live(
  "retains a user's declared upstream plugin version and manifest metadata",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        await Bun.write(path.join(dir, ".npmrc"), "registry=https://registry.npmjs.org/\naudit=false\n")
        await Bun.write(
          path.join(dir, "package.json"),
          JSON.stringify({
            name: "user-config",
            private: true,
            scripts: { custom: "fixture" },
            dependencies: { "@opencode-ai/plugin": "~1.18.34" },
          }),
        )
      })
      const install = yield* ConfigDependencies.make
      yield* install(dir)
      yield* Effect.promise(async () => {
        const manifest = await Bun.file(path.join(dir, "package.json")).json()
        expect(manifest.dependencies["@opencode-ai/plugin"]).toBe("~1.18.34")
        expect(manifest.dependencies["@flynncode/plugin"]).toBeUndefined()
        expect(manifest.scripts).toEqual({ custom: "fixture" })
        expect(await Bun.file(path.join(dir, "node_modules/@opencode-ai/plugin/package.json")).exists()).toBe(true)
      })
    }),
  { timeout: 60_000 },
)
