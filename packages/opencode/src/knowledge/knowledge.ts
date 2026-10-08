import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { filesystem, path } from "@opencode-ai/core/effect/app-node-platform"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"

export class InvalidSlugError extends Schema.TaggedErrorClass<InvalidSlugError>()("Knowledge.InvalidSlugError", {
  slug: Schema.String,
}) {}

export interface Entry {
  slug: string
  title: string
  path: string
  updated: number
}

export interface Detail extends Entry {
  body: string
}

export interface Interface {
  readonly list: (input: { worktree: string }) => Effect.Effect<Entry[], InvalidSlugError | PlatformError>
  readonly get: (input: { worktree: string; slug: string }) => Effect.Effect<Detail | undefined, InvalidSlugError | PlatformError>
  readonly save: (input: {
    worktree: string
    slug: string
    title: string
    body: string
  }) => Effect.Effect<{ slug: string; path: string }, InvalidSlugError | PlatformError>
  readonly remove: (input: { worktree: string; slug: string }) => Effect.Effect<void, InvalidSlugError | PlatformError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Knowledge") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path

    const list = Effect.fn("Knowledge.list")(function* (input: { worktree: string }) {
      const dir = pathSvc.join(input.worktree, ".opencode", "knowledge")
      const names = yield* fs.readDirectory(dir).pipe(Effect.catchIf(isNotFound, () => Effect.succeed([])))
      const entries: Entry[] = []
      for (const name of names) {
        if (!name.endsWith(".md")) continue
        const file = pathSvc.join(dir, name)
        const stat = yield* fs.stat(file).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)))
        if (!stat) continue
        const content = yield* fs.readFileString(file)
        const parsed = parseFile(content, name.slice(0, -3))
        entries.push({
          slug: parsed.slug,
          title: parsed.title,
          path: file,
          updated: Option.getOrUndefined(stat.mtime)?.getTime() ?? 0,
        })
      }
      return entries.sort((a, b) => b.updated - a.updated)
    })

    const get = Effect.fn("Knowledge.get")(function* (input: { worktree: string; slug: string }) {
      if (!isValidSlug(input.slug)) return yield* new InvalidSlugError({ slug: input.slug })
      const file = pathSvc.join(input.worktree, ".opencode", "knowledge", `${input.slug}.md`)
      const content = yield* fs.readFileString(file).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)))
      if (content === undefined) return undefined
      const parsed = parseFile(content, input.slug)
      return { slug: parsed.slug, title: parsed.title, path: file, body: parsed.body, updated: 0 }
    })

    const save = Effect.fn("Knowledge.save")(function* (input: {
      worktree: string
      slug: string
      title: string
      body: string
    }) {
      if (!isValidSlug(input.slug)) return yield* new InvalidSlugError({ slug: input.slug })
      const dir = pathSvc.join(input.worktree, ".opencode", "knowledge")
      const file = pathSvc.join(dir, `${input.slug}.md`)
      yield* fs.makeDirectory(dir, { recursive: true })
      // Titles ride on one frontmatter line, so fold newlines to spaces.
      const title = input.title.replaceAll("\n", " ")
      yield* fs.writeFileString(file, `---\ntitle: ${title}\n---\n${input.body}`)
      return { slug: input.slug, path: file }
    })

    const remove = Effect.fn("Knowledge.remove")(function* (input: { worktree: string; slug: string }) {
      if (!isValidSlug(input.slug)) return yield* new InvalidSlugError({ slug: input.slug })
      const file = pathSvc.join(input.worktree, ".opencode", "knowledge", `${input.slug}.md`)
      yield* fs.remove(file).pipe(Effect.catchIf(isNotFound, () => Effect.void))
    })

    return Service.of({ list, get, save, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [filesystem, path],
})

export * as Knowledge from "./knowledge"

function isValidSlug(slug: string) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)
}

function parseFile(content: string, fallback: string) {
  const lines = content.split("\n")
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1)
    if (end !== -1) {
      const title = lines
        .slice(1, end)
        .find((line) => line.startsWith("title:"))
        ?.slice("title:".length)
        .trim()
      return {
        slug: fallback,
        title: title && title.length > 0 ? title : fallback,
        body: lines.slice(end + 1).join("\n"),
      }
    }
  }
  return { slug: fallback, title: fallback, body: content }
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false
  if (!("reason" in error) || !error.reason || typeof error.reason !== "object") return false
  if (!("_tag" in error.reason)) return false
  return error.reason._tag === "NotFound"
}
