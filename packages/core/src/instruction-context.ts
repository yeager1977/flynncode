export * as InstructionContext from "./instruction-context"

import path, { isAbsolute, join, relative, sep } from "path"
import { Array, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Config } from "./config"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { httpClient } from "./effect/app-node-platform"
import { makeLocationNode } from "./effect/app-node"

class File extends Schema.Class<File>("InstructionContext.File")({
  // An absolute file path, or the URL of a configured remote instruction.
  path: Schema.String,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      const start = yield* fs.resolve(location.directory)
      const stop = yield* fs.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set(
        yield* Effect.forEach(
          Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !insideProject
            ? []
            : yield* fs.up({
                targets: ["AGENTS.md"],
                start,
                stop,
              }),
          fs.resolve,
        ),
      )
      const paths = Array.dedupe([yield* fs.resolve(join(global.config, "AGENTS.md")), ...discovered])

      // Configured `instructions` entries are explicit requests, not discovery: relative patterns walk
      // upward from the location to the project root, absolute and ~ paths resolve in place, and URLs
      // are fetched with a short timeout; failures skip the entry (ported from upstream 1e63a3bb73).
      const configuredPaths = new Set<string>()
      const configuredRemote: File[] = []
      const entries = yield* config.entries()
      const sources = Array.dedupe(
        entries.flatMap((entry) => (entry.type === "document" ? (entry.info.instructions ?? []) : [])),
      )
      const matchConfigured = Effect.fn("InstructionContext.matchConfigured")(function* (source: string) {
        const expanded = source.startsWith("~/") ? join(global.home, source.slice(2)) : source
        if (isAbsolute(expanded))
          return yield* fs
            .glob(path.basename(expanded), { cwd: path.dirname(expanded), absolute: true, include: "file" })
            .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        return yield* fs
          .globUp(expanded, start, stop)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      })
      const fetchRemote = Effect.fn("InstructionContext.fetchRemote")(function* (url: string) {
        const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
          Effect.timeout(5000),
          Effect.catch(() => Effect.succeed(null)),
        )
        if (!res) return
        const body = yield* res.arrayBuffer.pipe(
          Effect.map((buffer) => new TextDecoder().decode(buffer)),
          Effect.catch(() => Effect.succeed("")),
        )
        if (body) configuredRemote.push(new File({ path: url, content: body }))
      })
      for (const raw of sources) {
        if (raw.startsWith("https://") || raw.startsWith("http://")) {
          yield* fetchRemote(raw)
          continue
        }
        const matches = yield* matchConfigured(raw)
        for (const item of matches) configuredPaths.add(yield* fs.resolve(item))
      }

      const files = yield* Effect.forEach(
        paths,
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(
              Effect.map((content) =>
                content === undefined ? undefined : new File({ path: AbsolutePath.make(path), content }),
              ),
            ),
        { concurrency: "unbounded" },
      )
      const configuredFiles = yield* Effect.forEach(
        Array.fromIterable(configuredPaths),
        (item) => fs.readFileStringSafe(item).pipe(Effect.map((content) => (content === undefined ? undefined : new File({ path: item, content })))),
        { concurrency: "unbounded" },
      )
      const all = [...files, ...configuredFiles, ...configuredRemote]
      if (files.some((file, index) => file === undefined && discovered.has(paths[index])))
        return SystemContext.unavailable
      return all.filter((file): file is File => file !== undefined)
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((files) =>
          files === SystemContext.unavailable
            ? source(files)
            : files.length === 0
              ? SystemContext.empty
              : source(files),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-context",
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Config.node, SystemContextRegistry.node, httpClient],
})

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}
