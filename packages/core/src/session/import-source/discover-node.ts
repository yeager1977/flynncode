export * as DiscoverNode from "./discover-node"

import path from "node:path"
import { createReadStream } from "node:fs"
import { readdir, realpath, stat } from "node:fs/promises"
import { discover, sourceRootFor, type SourceCandidate } from "./discover.js"
import type { ImportSource } from "./types.js"

async function list(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => path.join(directory, entry.name))
}

// Streams a file line by line without holding the whole transcript in memory.
// Stopping iteration early cancels the stream; a file that disappears or
// cannot be read mid-way ends the iteration instead of failing discovery.
// This module stays on node:fs (no Bun APIs) like the rest of core.
async function* lines(file: string): AsyncIterable<string> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 })
  const chunks = stream[Symbol.asyncIterator]()
  let pending = ""
  try {
    while (true) {
      const next = await chunks.next().catch(() => undefined)
      if (!next || next.done) break
      const text = String(next.value)
      const last = text.lastIndexOf("\n")
      if (last === -1) {
        pending += text
        continue
      }
      const complete = (pending + text.slice(0, last)).split("\n")
      pending = text.slice(last + 1)
      yield* complete
    }
    if (pending) yield pending
  } finally {
    stream.destroy()
  }
}

async function fileStat(file: string) {
  const info = await stat(file).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  return { mtimeMs: info.mtimeMs, size: info.size }
}

export function discoverFromHome(input: {
  readonly source: ImportSource
  readonly home: string
  /** Only sessions whose cwd is this directory or inside it. */
  readonly cwd?: string
}): Promise<ReadonlyArray<SourceCandidate>> {
  return discover({ source: input.source, home: input.home, cwd: input.cwd, list, lines, stat: fileStat })
}

export type ResolvedSourceFile = {
  readonly source: ImportSource
  readonly path: string
}

// A path supplied by the client is only trusted when it resolves (through
// symlinks) to a regular .jsonl file inside the source store for that source.
// This lets fromSource parse one file directly instead of re-walking the
// entire store on every import.
export async function resolveSourceFile(input: {
  readonly source: ImportSource
  readonly home: string
  readonly path: string
}): Promise<ResolvedSourceFile | undefined> {
  if (path.extname(input.path) !== ".jsonl") return undefined
  // The store root itself may be a symlink (e.g. ~/.claude on another disk);
  // compare against its real path since the file is resolved the same way.
  const configured = path.resolve(sourceRootFor(input.source, input.home))
  const root = await realpath(configured).catch(() => configured)
  const resolved = await realpath(input.path).catch(() => undefined)
  if (resolved === undefined) return undefined
  const info = await stat(resolved).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  return { source: input.source, path: resolved }
}
