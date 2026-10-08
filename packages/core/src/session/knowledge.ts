export * as SessionKnowledge from "./knowledge"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"

export interface Title {
  slug: string
  title: string
}

export function parseKnowledgeTitle(content: string, fallback: string) {
  const lines = content.split("\n")
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1)
    if (end !== -1) {
      const title = lines
        .slice(1, end)
        .find((line) => line.startsWith("title:"))
        ?.slice("title:".length)
        .trim()
      if (title && title.length > 0) return title
    }
  }
  return fallback
}

export function buildKnowledgePrologue(entries: ReadonlyArray<Title>) {
  if (entries.length === 0) return ""
  return [
    "Project knowledge notes are available. Prefer them over guessing; read a note's file only when its title suggests it is relevant.",
    "<knowledge>",
    ...entries.map((entry) => `  - ${entry.title} (${entry.slug})`),
    "</knowledge>",
  ].join("\n")
}

export const listTitles = Effect.fn("SessionKnowledge.listTitles")(function* (
  fs: FSUtil.Interface,
  directory: string,
) {
  const dir = path.join(directory, ".opencode", "knowledge")
  const names = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([])))
  const titles: Title[] = []
  for (const name of names) {
    if (!name.endsWith(".md")) continue
    const slug = name.slice(0, -3)
    const content = yield* fs.readFileString(path.join(dir, name)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (content === undefined) continue
    titles.push({ slug, title: parseKnowledgeTitle(content, slug) })
  }
  // Slug order keeps the prologue deterministic for prompt caching.
  return titles.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
})
