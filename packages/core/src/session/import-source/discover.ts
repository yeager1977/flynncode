export * as Discover from "./discover"

import path from "node:path"
import { claudeCodeReader } from "./claude-code.js"
import { codexReader } from "./codex.js"
import type { ImportSource, ParsedSession } from "./types.js"

export type SourceCandidate = {
  readonly path: string
  readonly source: ImportSource
  readonly sourceSessionID: string
  readonly title: string
  readonly cwd: string
  readonly time: number
  readonly messageCount: number
}

export type FileStat = { readonly mtimeMs: number; readonly size: number }

type DiscoverInput = {
  readonly source: ImportSource
  readonly home: string
  readonly list: (dir: string) => Promise<ReadonlyArray<string>>
  /** Streams a file's lines; stopping iteration early must release the file. */
  readonly lines: (path: string) => AsyncIterable<string>
  readonly stat: (path: string) => Promise<FileStat | undefined>
  /** Only sessions whose cwd is this directory or inside it. */
  readonly cwd?: string
}

export function sourceRootFor(source: ImportSource, home: string) {
  return source === "claude-code"
    ? path.join(home, ".claude", "projects")
    : path.join(home, ".codex", "sessions")
}

// Parallelism bound for transcript reads: enough to overlap disk latency
// without spiking memory on large transcript stores.
const PARSE_CONCURRENCY = 8

// Per-file summaries keyed by source and path, reused while the file's mtime
// and size are unchanged. Only summaries (never message bodies) are kept, so a
// multi-gigabyte store costs one streaming pass and then stat calls.
type Cached = FileStat & { readonly cwd?: string; readonly summary?: ParsedSession }
const cache = new Map<string, Cached>()

export async function discover(input: DiscoverInput): Promise<ReadonlyArray<SourceCandidate>> {
  const root = sourceRootFor(input.source, input.home)
  const filter = input.cwd === undefined ? undefined : path.resolve(input.cwd)
  const files = await collectFiles(input, root, filter)
  const summaries = await summarizeFiles(input, files, filter)
  return summaries
    .filter((item) => item.messageCount > 0 && (filter === undefined || within(item.cwd, filter)))
    .map((item) => candidate(input.source, item))
    .sort((a, b) => b.time - a.time)
}

async function collectFiles(input: DiscoverInput, root: string, filter: string | undefined) {
  const found: string[] = []
  const queue = [root]
  const visited = new Set<string>()
  // Claude Code names each project directory after its cwd with every
  // non-alphanumeric character replaced by "-", so a cwd filter can skip
  // other projects without reading them.
  const project = filter === undefined || input.source !== "claude-code" ? undefined : filter.replace(/[^a-zA-Z0-9]/g, "-")
  while (queue.length) {
    const dir = queue.shift()
    if (dir === undefined || visited.has(dir)) continue
    visited.add(dir)
    for (const entry of await input.list(dir)) {
      if (path.extname(entry) === ".jsonl") found.push(entry)
      else if (dir !== root || project === undefined) queue.push(entry)
      else if (path.basename(entry) === project || path.basename(entry).startsWith(`${project}-`)) queue.push(entry)
    }
  }
  return found
}

async function summarizeFiles(input: DiscoverInput, files: ReadonlyArray<string>, filter: string | undefined) {
  const summaries: ParsedSession[] = []
  const queue = [...files]
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const summary = await summarize(input, file, filter)
      if (summary) summaries.push(summary)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, files.length) }, worker))
  return summaries
}

async function summarize(input: DiscoverInput, file: string, filter: string | undefined) {
  const info = await input.stat(file)
  if (info === undefined) return undefined
  const key = `${input.source}:${file}`
  const cached = cache.get(key)
  const fresh = cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size ? cached : undefined
  if (fresh?.summary) return fresh.summary
  // A cached cwd outside the filter answers without reading the file again.
  if (fresh?.cwd !== undefined && filter !== undefined && !within(fresh.cwd, filter)) return undefined
  const reader = input.source === "claude-code" ? claudeCodeReader(file, { keepMessages: false }) : codexReader(file, { keepMessages: false })
  for await (const line of input.lines(file)) {
    reader.push(line)
    const cwd = reader.cwd()
    // Stop at the first record that places the session outside the filter.
    if (filter !== undefined && cwd !== undefined && !within(cwd, filter)) {
      cache.set(key, { ...info, cwd })
      return undefined
    }
  }
  const summary = reader.finish()
  cache.set(key, { ...info, cwd: summary.cwd, summary })
  return summary
}

function within(cwd: string, filter: string) {
  return cwd === filter || cwd.startsWith(filter.endsWith(path.sep) ? filter : filter + path.sep)
}

const candidate = (source: ImportSource, parsed: ParsedSession): SourceCandidate => ({
  path: parsed.sourcePath,
  source,
  sourceSessionID: parsed.sourceSessionID,
  title: parsed.title,
  cwd: parsed.cwd,
  time: parsed.time,
  messageCount: parsed.messageCount,
})
