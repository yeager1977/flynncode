export * as Discover from "./discover"

import path from "node:path"
import { parseClaudeCode } from "./claude-code.js"
import { parseCodex } from "./codex.js"
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

type DiscoverInput = {
  readonly source: ImportSource
  readonly home: string
  readonly read: (path: string) => Promise<string | undefined>
  readonly list: (dir: string) => Promise<ReadonlyArray<string>>
}

async function collectFiles(list: DiscoverInput["list"], root: string) {
  const found: string[] = []
  const queue = [root]
  const visited = new Set<string>()
  while (queue.length) {
    const dir = queue.shift()
    if (dir === undefined || visited.has(dir)) continue
    visited.add(dir)
    for (const entry of await list(dir)) {
      if (path.extname(entry) === ".jsonl") found.push(entry)
      else queue.push(entry)
    }
  }
  return found
}

export function sourceRootFor(source: ImportSource, home: string) {
  return source === "claude-code"
    ? path.join(home, ".claude", "projects")
    : path.join(home, ".codex", "sessions")
}

// Parallelism bound for transcript reads/parses: enough to overlap disk latency
// without spiking memory on large transcript stores.
const PARSE_CONCURRENCY = 8

async function parseFiles(input: DiscoverInput, files: ReadonlyArray<string>): Promise<ReadonlyArray<ParsedSession>> {
  const parsed: ParsedSession[] = []
  let cursor = 0
  const worker = async () => {
    while (cursor < files.length) {
      const file = files[cursor++]!
      const text = await input.read(file)
      if (text === undefined) continue
      const result = input.source === "claude-code" ? parseClaudeCode({ path: file, text }) : parseCodex({ path: file, text })
      parsed.push(result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, files.length) }, worker))
  return parsed
}

const candidate = (source: ImportSource, parsed: ParsedSession): SourceCandidate => {
  const first = parsed.messages[0]
  return {
    path: parsed.sourcePath,
    source,
    sourceSessionID: parsed.sourceSessionID,
    title: parsed.title,
    cwd: parsed.cwd,
    time: first?.time ?? 0,
    messageCount: parsed.messages.length,
  }
}

export async function discover(input: DiscoverInput): Promise<ReadonlyArray<SourceCandidate>> {
  const root = sourceRootFor(input.source, input.home)
  const files = await collectFiles(input.list, root)
  const parsed = await parseFiles(input, files)
  return parsed
    .filter((item) => item.messages.length > 0)
    .map((item) => candidate(input.source, item))
    .sort((a, b) => b.time - a.time)
}
