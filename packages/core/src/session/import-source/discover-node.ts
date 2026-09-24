export * as DiscoverNode from "./discover-node"

import path from "node:path"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { discover, sourceRootFor, type SourceCandidate } from "./discover.js"
import type { ImportSource } from "./types.js"

async function list(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => path.join(directory, entry.name))
}

async function read(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").catch(() => undefined)
}

export function discoverFromHome(input: {
  readonly source: ImportSource
  readonly home: string
}): Promise<ReadonlyArray<SourceCandidate>> {
  return discover({ source: input.source, home: input.home, read, list })
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
  const root = path.resolve(sourceRootFor(input.source, input.home))
  const resolved = await realpath(input.path).catch(() => undefined)
  if (resolved === undefined) return undefined
  const info = await stat(resolved).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  return { source: input.source, path: resolved }
}
