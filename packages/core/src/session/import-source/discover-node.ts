export * as DiscoverNode from "./discover-node"

import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { discover, type SourceCandidate } from "./discover.js"
import type { ImportSource } from "./types.js"

async function list(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  return entries.map((entry) => path.join(directory, entry.name))
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