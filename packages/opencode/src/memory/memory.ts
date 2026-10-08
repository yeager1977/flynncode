import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { ConfigMemoryV1 } from "@opencode-ai/core/v1/config/memory"
import { InstanceState } from "@/effect/instance-state"
import { MemoryRedact } from "./redact"

export interface LoadedMemory {
  filepath: string
  content: string
}

export interface Interface {
  readonly isEnabled: () => Effect.Effect<boolean>
  readonly globalDir: () => Effect.Effect<string>
  readonly projectDir: () => Effect.Effect<string>
  readonly list: () => Effect.Effect<string[]>
  readonly load: () => Effect.Effect<LoadedMemory[]>
  readonly append: (input: { scope: "global" | "project"; filename: string; text: string }) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

function sanitizeFilename(raw: string) {
  const base = path.basename(raw).toLowerCase()
  const cleaned = base.replace(/[^a-z0-9._-]/g, "-").replace(/-{2,}/g, "-")
  if (!cleaned.endsWith(".md")) return "memory.md"
  if (!/^[a-z0-9][a-z0-9._-]*\.md$/.test(cleaned)) return "memory.md"
  return cleaned
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service

    const settings = Effect.fn("Memory.settings")(function* () {
      return ConfigMemoryV1.resolved((yield* config.get()).memory ?? {})
    })

    const isEnabled = Effect.fn("Memory.isEnabled")(function* () {
      return (yield* settings()).enabled
    })

    const globalDir = Effect.fn("Memory.globalDir")(function* () {
      return path.join(global.data, "memories")
    })

    const projectDir = Effect.fn("Memory.projectDir")(function* () {
      const ctx = yield* InstanceState.context
      const root = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
      return path.join(root, ".opencode", "memories")
    })

    const list = Effect.fn("Memory.list")(function* () {
      if (!(yield* isEnabled())) return []
      const dirs = [yield* globalDir(), yield* projectDir()]
      const found: string[] = []
      for (const dir of dirs) {
        const entries = yield* fs.glob("*.md", { cwd: dir, absolute: true, include: "file" }).pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
        )
        found.push(...entries.toSorted())
      }
      const limit = (yield* settings()).max_files
      return found.slice(0, limit)
    })

    const load = Effect.fn("Memory.load")(function* (): Effect.Effect<LoadedMemory[]> {
      if (!(yield* isEnabled())) return []
      const cap = (yield* settings()).max_chars_per_file
      const files = yield* list()
      const out: LoadedMemory[] = []
      for (const filepath of files) {
        const raw = yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
        const redacted = MemoryRedact.redactSecrets(raw).slice(0, cap)
        if (redacted.trim()) out.push({ filepath, content: `Memory from: ${filepath}\n${redacted}` })
      }
      return out
    })

    const append = Effect.fn("Memory.append")(function* (input: {
      scope: "global" | "project"
      filename: string
      text: string
    }) {
      if (!(yield* isEnabled())) return ""
      const body = MemoryRedact.redactSecrets(input.text)
      if (!body.trim()) return ""
      const dir = input.scope === "global" ? yield* globalDir() : yield* projectDir()
      const target = path.join(dir, sanitizeFilename(input.filename))
      yield* fs.writeWithDirs(target, body).pipe(Effect.orDie)
      return target
    })

    return Service.of({ isEnabled, globalDir, projectDir, list, load, append })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Global.node, FSUtil.node],
})

export * as Memory from "./memory"
