import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Context, Effect, Layer, Option, Semaphore } from "effect"
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
  readonly target: (input: { scope: "global" | "project"; slug: string }) => Effect.Effect<string>
  readonly snapshot: (scope: "global" | "project") => Effect.Effect<ReadonlyMap<string, string>>
  readonly reconcile: (input: {
    scope: "global" | "project"
    topics: readonly { slug: string; text: string }[]
    before: ReadonlyMap<string, string>
    current: () => boolean
  }) => Effect.Effect<void>
  readonly list: () => Effect.Effect<string[]>
  readonly listDetailed: () => Effect.Effect<Array<{ scope: "global" | "project"; filepath: string }>>
  readonly load: () => Effect.Effect<LoadedMemory[]>
  readonly update: (input: { scope: "global" | "project"; slug: string; text: string }) => Effect.Effect<string>
  readonly remove: (input: { scope: "global" | "project"; slug: string }) => Effect.Effect<boolean>
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

// Slugs become memory filenames, so restrict to kebab characters (no dots,
// no separators) to guarantee path.join can never escape the memories dir.
function sanitizeSlug(raw: string) {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  if (!cleaned) return "topic.md"
  return `${cleaned}.md`
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    // All scopes share one mutation boundary, including explicit memory edits.
    // No topic/session lock map survives indefinitely.
    const mutations = yield* Semaphore.make(1)

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

    const target = Effect.fn("Memory.target")(function* (input: { scope: "global" | "project"; slug: string }) {
      return path.join(input.scope === "global" ? yield* globalDir() : yield* projectDir(), sanitizeSlug(input.slug))
    })

    const snapshot = Effect.fn("Memory.snapshot")(function* (scope: "global" | "project") {
      const dir = scope === "global" ? yield* globalDir() : yield* projectDir()
      const files = yield* fs.glob("*.md", { cwd: dir, absolute: true, include: "file" }).pipe(Effect.orElseSucceed(() => []))
      return new Map(yield* Effect.forEach(files, file => fs.readFileString(file).pipe(Effect.map(text => [file, text] as const), Effect.orElseSucceed(() => [file, ""] as const))))
    }, mutations.withPermit)

    const listDetailed = Effect.fn("Memory.listDetailed")(function* () {
      if (!(yield* isEnabled())) return []
      const dirs: Array<{ scope: "global" | "project"; dir: string }> = [
        { scope: "global", dir: yield* globalDir() },
        { scope: "project", dir: yield* projectDir() },
      ]
      const found: Array<{ scope: "global" | "project"; filepath: string }> = []
      for (const entry of dirs) {
        const entries = yield* fs.glob("*.md", { cwd: entry.dir, absolute: true, include: "file" }).pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
        )
        found.push(...entries.toSorted().map((filepath) => ({ scope: entry.scope, filepath })))
      }
      const limit = (yield* settings()).max_files
      return found.slice(0, limit)
    })

    const list = Effect.fn("Memory.list")(function* () {
      return (yield* listDetailed()).map((entry) => entry.filepath)
    })

    const load = Effect.fn("Memory.load")(function* () {
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

    // Deprecated: append overwrites the whole file, which caused per-day
    // data loss in extraction. Use `update` for per-topic create-or-replace.
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

    const update = Effect.fn("Memory.update")(function* (input: {
      scope: "global" | "project"
      slug: string
      text: string
    }, current?: () => boolean) {
      if (!(yield* isEnabled())) return ""
      const body = MemoryRedact.redactSecrets(input.text)
      // Effective-empty text is a no-op: never write an empty topic file.
      if (!body.trim()) return ""
      const filepath = yield* target(input)
      // Identical-content skip: boundary triggers (compact/idle/drain) can
      // re-extract the same topic near one boundary; don't rewrite the file.
      const existing = yield* fs.readFileString(filepath).pipe(
        Effect.catch(() => Effect.succeed("")),
        Effect.map((content) => (content === body ? Option.some(filepath) : Option.none())),
      )
      if (Option.isSome(existing)) return existing.value
      if (current && !current()) return ""
      yield* fs.writeWithDirs(filepath, body).pipe(Effect.orDie)
      return filepath
    })

    const remove = Effect.fn("Memory.remove")(function* (input: {
      scope: "global" | "project"
      slug: string
    }, current?: () => boolean) {
      if (!(yield* isEnabled())) return false
      const filepath = yield* target(input)
      if (current && !current()) return false
      return yield* fs.remove(filepath).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      )
    })

    const reconcile: Interface["reconcile"] = Effect.fn("Memory.reconcile")(function* (input) {
      if (!input.current()) return
      for (const topic of input.topics) {
        const filepath = yield* target({ scope: input.scope, slug: topic.slug })
        const existing = yield* fs.readFileString(filepath).pipe(Effect.orElseSucceed(() => undefined))
        // Optimistic reconciliation: an extraction may replace only the topic
        // content it observed before inference, never a concurrent user's edit.
        if (!input.current()) return
        if (existing !== input.before.get(filepath)) continue
        if (!topic.text.trim()) {
          yield* remove({ scope: input.scope, slug: topic.slug }, input.current)
          continue
        }
        yield* update({ scope: input.scope, ...topic }, input.current)
      }
    }, mutations.withPermit)

    return Service.of({
      isEnabled, globalDir, projectDir, target, snapshot, reconcile, list, listDetailed, load,
      update: input => mutations.withPermit(update(input)),
      remove: input => mutations.withPermit(remove(input)),
      append: input => mutations.withPermit(append(input)),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Global.node, FSUtil.node],
})

export * as Memory from "./memory"
