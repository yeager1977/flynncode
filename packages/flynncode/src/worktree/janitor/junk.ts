import { lstat, readdir, rm, rmdir } from "node:fs/promises"
import path from "path"

// Junk is only ever removed inside idle worktrees; the janitor caller enforces that.
// node_modules and .git are never descended: node_modules is huge and needed to run
// the project (not junk), and .git is repository state.
export const JUNK: ReadonlySet<string> = new Set([
  ".pytest_cache",
  "__pycache__",
  ".mypy_cache",
  ".ruff_cache",
  ".turbo",
  "coverage",
])

const JUNK_PREFIX = "pytest-of-"
const SKIPPED = new Set([".git", "node_modules"])

export function isJunk(name: string) {
  return JUNK.has(name) || name.startsWith(JUNK_PREFIX)
}

export async function removeJunk(root: string) {
  const removed: string[] = []
  let bytes = 0

  // Returns whether anything under dir was removed, so only directories this pass
  // emptied are pruned; directories that were already empty are left alone.
  async function walk(dir: string): Promise<boolean> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const results = []
    for (const entry of entries) {
      const target = path.join(dir, entry.name)
      // Dirent never follows symlinks, so a junk-named link is removed as a link only.
      if ((entry.isDirectory() || entry.isSymbolicLink()) && isJunk(entry.name)) {
        bytes += (await size(target, { budgetMs: Infinity })).bytes
        await rm(target, { recursive: true, force: true })
        removed.push(target)
        results.push(true)
        continue
      }
      if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue
      const changed = await walk(target)
      if (changed && (await readdir(target).catch(() => [undefined])).length === 0)
        await rmdir(target).catch(() => undefined)
      results.push(changed)
    }
    return results.some(Boolean)
  }

  await walk(root)
  return { removed, bytes }
}

export async function size(root: string, input?: { budgetMs?: number }) {
  const deadline = Date.now() + (input?.budgetMs ?? 30_000)
  // lstat the root first: readdir on a symlink root would walk its target.
  const top = await lstat(root).catch(() => undefined)
  if (!top?.isDirectory()) return { bytes: top?.size ?? 0, capped: false }
  const pending = [root]
  let bytes = 0
  while (pending.length > 0) {
    const dir = pending.pop()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (Date.now() >= deadline) return { bytes, capped: true }
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else bytes += (await lstat(target).catch(() => undefined))?.size ?? 0
    }
  }
  return { bytes, capped: false }
}

export * as JanitorJunk from "./junk"
