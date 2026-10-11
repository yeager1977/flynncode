import * as InstanceState from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Effect, Layer, Option } from "effect"
import ignore from "ignore"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const locations = yield* LocationServiceMap.Service

    const filesystem = Effect.fnUntraced(function* <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(root) }))),
      )
    })

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .grep({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).map((match) => ({
        path: { text: match.entry.path },
        lines: { text: match.text },
        line_number: match.line,
        absolute_offset: match.offset,
        submatches: match.submatches.map((submatch) => ({
          match: { text: submatch.text },
          start: submatch.start,
          end: submatch.end,
        })),
      }))
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const instance = yield* InstanceState.context
      const limit = ctx.query.limit ?? 10
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined)
      const started = performance.now()
      const roots = [instance.directory, ...instance.additionalDirectories]
      const rooted = yield* Effect.forEach(roots, (root) =>
        filesystem(
          root,
          FileSystem.Service.use((fs) => fs.find({ query: ctx.query.query, limit, type })).pipe(
            Effect.map((items) =>
              items.map((item) => (root === instance.directory ? item.path : path.resolve(root, item.path))),
            ),
          ),
        ),
      )
      const found = rooted.flat()
      yield* Effect.logInfo("find file", {
        query: ctx.query.query,
        type,
        directory: instance.directory,
        limit,
        results: found.length,
        duration: Math.round(performance.now() - started),
      })
      return found
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      const instance = yield* InstanceState.context
      // Multifold: the file tree accepts absolute paths into any boundary
      // root and surfaces attached folders at the primary root, mirroring the
      // content handler's read-root selection. Paths outside the boundary
      // union are refused.
      const target = path.resolve(instance.directory, ctx.query.path)
      if (!containsPath(target, instance)) return yield* Effect.die(new Error("Path escapes the location"))
      const root =
        [instance.directory, ...instance.additionalDirectories, instance.worktree].find((dir) =>
          FSUtil.contains(dir, target),
        ) ?? instance.directory
      // Entry paths under an extra root are absolute so tree navigation
      // round-trips them back through this handler; the primary root keeps
      // its legacy relative paths.
      const extra = root !== instance.directory
      const atRoot = target === instance.directory
      const extras = instance.additionalDirectories.filter((dir) => !FSUtil.contains(instance.directory, dir))
      return yield* filesystem(
        root,
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const raw = yield* FSUtil.Service
          const location = yield* Location.Service
          const ignored = ignore()
          const gitignore = yield* raw
            .readFileString(path.join(location.project.directory, ".gitignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (gitignore) ignored.add(gitignore)
          const ignorefile = yield* raw
            .readFileString(path.join(location.project.directory, ".ignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (ignorefile) ignored.add(ignorefile)
          const entries = (yield* fs.list({ path: RelativePath.make(path.relative(root, target)) })).map((item) => ({
            name: path.basename(item.path),
            path: extra ? path.resolve(root, item.path) : item.path,
            absolute: path.resolve(root, item.path),
            type: item.type,
            ignored: ignored.ignores(
              path.relative(location.project.directory, path.resolve(root, item.path)) +
                (item.type === "directory" ? "/" : ""),
            ),
          }))
          // Attached folders outside the primary tree are not visible through
          // the primary listing, so expose them as entries at the root.
          return extra || !atRoot
            ? entries
            : [
                ...entries,
                ...extras.map((dir) => ({
                  name: path.basename(dir),
                  path: dir,
                  absolute: dir,
                  type: "directory" as const,
                  ignored: false,
                })),
              ]
        }),
      )
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const instance = yield* InstanceState.context
      const directory = instance.directory
      const file = path.resolve(directory, ctx.query.path)
      // Multifold: content reads accept attached folders through the central
      // boundary check. The worktree-"/" guard stays inside containsPath, so
      // non-git projects keep external_directory permissions intact.
      if (!containsPath(file, instance)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file)))) return { type: "text" as const, content: "" }
      // Each read goes through the Location of the root that holds the file,
      // so an attached folder keeps its own containment check instead of
      // failing the primary Location's boundary.
      const root =
        [instance.directory, ...instance.additionalDirectories, instance.worktree].find((dir) =>
          FSUtil.contains(dir, file),
        ) ?? directory
      return yield* FileSystem.Service.use((fs) =>
        fs.read({ path: RelativePath.make(path.relative(root, file)) }),
      ).pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(root) }))),
        Effect.flatMap((item) =>
          Effect.gen(function* () {
            const text = item.content.includes(0)
              ? Option.none<string>()
              : yield* Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(item.content)).pipe(
                  Effect.option,
                )
            return { item, text }
          }),
        ),
        Effect.map(({ item, text }) =>
          Option.isSome(text)
            ? { type: "text" as const, content: text.value.trim() }
            : {
                type: "binary" as const,
                content: Buffer.from(item.content).toString("base64"),
                encoding: "base64" as const,
                mimeType: item.mime,
              },
        ),
      )
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
  }),
).pipe(Layer.provide(locationServiceMapLayer))
