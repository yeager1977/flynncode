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

// `file` is a path relative to the worktree as git prints it ("/"-separated, a
// whole ignored directory ends in "/"). Only the entry itself counts: an ignored
// file inside a tracked `out/` or `dist/` folder is still local data.
export function isRegenerable(file: string) {
  const name = file.split("/").filter(Boolean).at(-1) ?? ""
  if (file.endsWith("/")) return REGENERABLE.has(name) || name.startsWith(JUNK_PREFIX)
  return name.endsWith(".pyc") || name.endsWith(".tsbuildinfo") || name === ".DS_Store"
}

// Junk directories (and junk-named links) under root. Never descends into junk,
// .git or node_modules; empty when root is not a real directory.
export async function findJunk(root: string) {
  // lstat the root first: walking a symlink root would find junk in its target.
  if (!(await lstat(root).catch(() => undefined))?.isDirectory()) return []

  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const found: string[] = []
    for (const entry of entries) {
      const target = path.join(dir, entry.name)
      // Dirent never follows symlinks, so a junk-named link is listed as a link only.
      if ((entry.isDirectory() || entry.isSymbolicLink()) && isJunk(entry.name)) {
        found.push(target)
        continue
      }
      if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue
      found.push(...(await walk(target)))
    }
    return found
  }

  return walk(root)
}

export async function removeJunk(root: string, options?: { skip?: (target: string) => boolean }) {
  const items: { path: string; bytes: number }[] = []
  for (const target of (await findJunk(root)).filter((target) => !options?.skip?.(target))) {
    const bytes = (await size(target, { budgetMs: Infinity })).bytes
    // A target that cannot be deleted (permissions, busy) is skipped so the rest
    // of the pass still runs; force already ignores ENOENT.
    const ok = await rm(target, { recursive: true, force: true }).then(
      () => true,
      () => false,
    )
    if (!ok) continue
    items.push({ path: target, bytes })
    await prune(root, path.dirname(target))
  }
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

// Removes the directories a junk removal emptied, walking up to (never including)
// root. Directories that were already empty elsewhere are left alone.
async function prune(root: string, dir: string): Promise<void> {
  if (!dir.startsWith(root + path.sep)) return
  if ((await readdir(dir).catch(() => [undefined])).length !== 0) return
  const ok = await rmdir(dir).then(
    () => true,
    () => false,
  )
  if (ok) return prune(root, path.dirname(dir))
}

export * as JanitorJunk from "./junk"
