import { describe, expect } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { badArgument } from "effect/PlatformError"
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

// In-memory platform FileSystem double for observing writes: records every
// writeFileString call so the identical-content no-op skip in Memory.update
// can be asserted. Served from the outer test env — an inner Effect.provide
// cannot override the outer runtime's filesystem.
const noopWrites: string[] = []
const noopFiles = new Map<string, string>()
const noopFs = FileSystem.makeNoop({
  makeDirectory: () => Effect.void,
  writeFileString: (filepath, data) =>
    Effect.sync(() => {
      const content = typeof data === "string" ? data : new TextDecoder().decode(data)
      noopWrites.push(filepath)
      noopFiles.set(filepath, content)
    }),
  readFileString: (filepath) => {
    const content = noopFiles.get(filepath)
    return content === undefined
      ? Effect.fail(badArgument({ module: "memory-test", method: "readFileString", description: "not found" }))
      : Effect.succeed(content)
  },
  remove: (filepath) =>
    Effect.sync(() => {
      noopFiles.delete(filepath)
    }),
})

// Environment for filesystem-observation tests; project scope only, so the
// static Global overrides never matter.
const itFs = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, Memory.node]), [
    [LayerNodePlatform.filesystem, Layer.succeed(FileSystem.FileSystem, noopFs)],
    [
      Config.node,
      Layer.succeed(
        Config.Service,
        TestConfig.make({ get: () => Effect.succeed({ memory: { enabled: true } }) as Effect.Effect<never> as never }),
      ),
    ],
    [Global.node, Global.layerWith({ home: "memory-test", config: "memory-test", data: "memory-test" })],
  ]),
)

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

  it.live("update creates then replaces a topic entry", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const svc = yield* Memory.Service
        const target = yield* svc.update({ scope: "project", slug: "test-runner", text: "always use bun" })
        expect(target.endsWith("test-runner.md")).toBe(true)
        expect((yield* svc.load()).some((m) => m.content.includes("always use bun"))).toBe(true)
        yield* svc.update({ scope: "project", slug: "test-runner", text: "vitest only" })
        const after = yield* svc.load()
        expect(after.length).toBe(1)
        expect(after[0].content).toContain("vitest only")
        expect(after[0].content).not.toContain("always use bun")
        expect(yield* svc.remove({ scope: "project", slug: "test-runner" })).toBe(true)
        expect(yield* svc.load()).toEqual([])
      }).pipe(Effect.provide(memoryLayer({ enabled: true }, { home: dir, config: dir, data: dir }))),
    ),
  )

  itFs.live("update skips no-op rewrite when content is unchanged", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        noopWrites.length = 0
        noopFiles.clear()
        const svc = yield* Memory.Service
        const target = yield* svc.update({ scope: "project", slug: "runner", text: "always use bun" })
        expect(noopWrites.length).toBe(1)
        expect(noopFiles.get(target)).toBe("always use bun")
        // Same redacted content must not rewrite the topic file.
        yield* svc.update({ scope: "project", slug: "runner", text: "always use bun" })
        yield* svc.update({ scope: "project", slug: "runner", text: "always use bun" })
        expect(noopWrites.length).toBe(1)
        // Changed content replaces in one more write.
        yield* svc.update({ scope: "project", slug: "runner", text: "vitest only" })
        expect(noopWrites.length).toBe(2)
        expect(noopFiles.get(target)).toBe("vitest only")
        // Content that redacts differently from the stored entry still writes.
        yield* svc.update({ scope: "project", slug: "runner", text: "token ghp_abcdefghij1234567890" })
        expect(noopWrites.length).toBe(3)
        expect(noopFiles.get(target) ?? "").not.toContain("ghp_")
      }),
    ),
  )

  it.live("update skips empty text and sanitizes slug traversal", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const svc = yield* Memory.Service
        expect(yield* svc.update({ scope: "project", slug: "empty-topic", text: "   " })).toBe("")
        expect(yield* svc.load()).toEqual([])
        const projectDir = yield* svc.projectDir()
        const target = yield* svc.update({
          scope: "project",
          slug: "../../evil slug",
          text: "Use ripgrep.",
        })
        expect(target.startsWith(projectDir)).toBe(true)
        expect(target.endsWith("evil-slug.md")).toBe(true)
        expect(yield* svc.remove({ scope: "project", slug: "@/escape" })).toBe(false)
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.readFileString(target)).toContain("Use ripgrep.")
      }).pipe(Effect.provide(memoryLayer({ enabled: true }, { home: dir, config: dir, data: dir }))),
    ),
  )
})

export { tmpdirScoped }
