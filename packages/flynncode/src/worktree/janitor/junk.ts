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

// Ignored files under these names are rebuilt by tooling, so they never hold a
// worktree back from auto-removal; any other ignored file (.env, local config) does.
const REGENERABLE = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
])

export function isJunk(name: string) {
  return JUNK.has(name) || name.startsWith(JUNK_PREFIX)
}

// `file` is a path relative to the worktree as git prints it ("/"-separated).
export function isRegenerable(file: string) {
  const parts = file.split("/").filter(Boolean)
  const name = parts.at(-1) ?? ""
  return (
    parts.some((part) => REGENERABLE.has(part) || part.startsWith(JUNK_PREFIX)) ||
    name.endsWith(".pyc") ||
    name.endsWith(".tsbuildinfo") ||
    name === ".DS_Store"
  )
}

export async function removeJunk(root: string, options?: { skip?: (target: string) => boolean | Promise<boolean> }) {
  const items: { path: string; bytes: number }[] = []
  // lstat the root first: walking a symlink root would delete junk in its target.
  if (!(await lstat(root).catch(() => undefined))?.isDirectory()) return { removed: [], bytes: 0, items }

  // Returns whether anything under dir was removed, so only directories this pass
  // emptied are pruned; directories that were already empty are left alone.
  async function walk(dir: string): Promise<boolean> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const results = []
    for (const entry of entries) {
      const target = path.join(dir, entry.name)
      // Dirent never follows symlinks, so a junk-named link is removed as a link only.
      if ((entry.isDirectory() || entry.isSymbolicLink()) && isJunk(entry.name)) {
        if (await options?.skip?.(target)) continue
        const bytes = (await size(target, { budgetMs: Infinity })).bytes
        // A target that cannot be deleted (permissions, busy) is skipped so the
        // rest of the pass still runs; force already ignores ENOENT.
        const ok = await rm(target, { recursive: true, force: true }).then(
          () => true,
          () => false,
        )
        if (!ok) continue
        items.push({ path: target, bytes })
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
  return { removed: items.map((item) => item.path), bytes: items.reduce((sum, item) => sum + item.bytes, 0), items }
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
