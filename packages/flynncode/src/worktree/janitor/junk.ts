import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises"
import path from "path"

// Junk is only ever removed inside idle worktrees; the janitor caller enforces that.
// Dependency trees are never descended: node_modules, virtualenvs and site-packages
// are needed to run the project and ship their own `coverage` and similar packages,
// and .git is repository state.
export const JUNK: ReadonlySet<string> = new Set([
  ".pytest_cache",
  "__pycache__",
  ".mypy_cache",
  ".ruff_cache",
  ".turbo",
  "coverage",
])

const JUNK_PREFIX = "pytest-of-"
const SKIPPED = new Set([".git", "node_modules", ".venv", "venv", "site-packages"])

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
// a SKIPPED folder or a nested repository (its files belong to that repo); empty
// when root is not a real directory.
export async function findJunk(root: string) {
  // lstat the root first: walking a symlink root would find junk in its target.
  if (!(await lstat(root).catch(() => undefined))?.isDirectory()) return []

  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    if (dir !== root && entries.some((entry) => entry.name === ".git")) return []
    const found: string[] = []
    for (const entry of entries) {
      const target = path.join(dir, entry.name)
      // Dirent never follows symlinks, so a junk-named link is listed as a link only.
      if ((entry.isDirectory() || entry.isSymbolicLink()) && isJunk(entry.name)) {
        // A junk-named folder that is itself a repository (a coverage-report repo) is not junk.
        const repo = entry.isDirectory() && (await lstat(path.join(target, ".git")).catch(() => undefined))
        if (!repo) found.push(target)
        continue
      }
      if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue
      found.push(...(await walk(target)))
    }
    return found
  }

  return walk(root)
}

// Deletes exactly the approved targets (a filtered findJunk result), never
// anything a fresh walk would find. A target that is not a junk-named entry
// inside root, or whose parent no longer resolves to itself (swapped for a
// symlink since the walk), is left alone.
export async function removeJunk(root: string, targets: string[]) {
  const items: { path: string; bytes: number }[] = []
  // lstat the root first: a symlink root would point the deletes at its target.
  if (!(await lstat(root).catch(() => undefined))?.isDirectory()) return { removed: [], bytes: 0, items }
  for (const target of targets) {
    if (!target.startsWith(root + path.sep) || !isJunk(path.basename(target))) continue
    if ((await realpath(path.dirname(target)).catch(() => undefined)) !== path.dirname(target)) continue
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

// Total file bytes, the newest mtime of any entry (lstat, links not followed) and
// `repos`: every folder below root holding a `.git` entry (file or directory),
// relative to root. `capped` means the walk ran out of time or could not read a
// folder, so all of them are lower bounds.
export async function size(root: string, input?: { budgetMs?: number }) {
  const deadline = Date.now() + (input?.budgetMs ?? 30_000)
  // lstat the root first: readdir on a symlink root would walk its target.
  const top = await lstat(root).catch(() => undefined)
  if (!top?.isDirectory()) return { bytes: top?.size ?? 0, capped: false, mtime: top?.mtimeMs ?? 0, repos: [] }
  const pending = [root]
  const repos: string[] = []
  let bytes = 0
  let mtime = top.mtimeMs
  let capped = false
  while (pending.length > 0) {
    const dir = pending.pop()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined)
    if (!entries) capped = true
    for (const entry of entries ?? []) {
      if (Date.now() >= deadline) return { bytes, capped: true, mtime, repos: repos.sort() }
      const target = path.join(dir, entry.name)
      if (entry.name === ".git" && dir !== root) repos.push(path.relative(root, dir))
      const info = await lstat(target).catch(() => undefined)
      mtime = Math.max(mtime, info?.mtimeMs ?? 0)
      if (entry.isDirectory()) pending.push(target)
      else bytes += info?.size ?? 0
    }
  }
  return { bytes, capped, mtime, repos: repos.sort() }
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
