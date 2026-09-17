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
  const root =
    input.source === "claude-code"
      ? path.join(input.home, ".claude", "projects")
      : path.join(input.home, ".codex", "sessions")

  const files = await collectFiles(input.list, root)
  const out: SourceCandidate[] = []
  for (const file of files) {
    const text = await input.read(file)
    if (text === undefined) continue
    const parsed = input.source === "claude-code" ? parseClaudeCode({ path: file, text }) : parseCodex({ path: file, text })
    if (!parsed.messages.length) continue
    out.push(candidate(input.source, parsed))
  }
  return out.sort((a, b) => b.time - a.time)
}