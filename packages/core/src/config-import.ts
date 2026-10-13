import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"

const marker = ".opencode-imported"
type Directory = { file: string; mode: number; dev: number; ino: number }

// A publication failure returns a private snapshot, never the writable source.
// If a complete snapshot cannot be made, return undefined and leave import retryable.
export async function importConfig(source: string, target: string) {
  try {
    // Fast path only when no finalization is pending. A present marker with a
    // present journal means a previous run may have stopped after the marker
    // write but before root restoration; that state must be recovered under
    // the import lock, never trusted here.
    if ((await stat(path.join(target, marker))) && !(await stat(journalFor(target)))) return target
    if (!(await stat(source))) return target
    const origin = await fs.realpath(source)
    if (!(await fs.stat(origin)).isDirectory()) return
    if (inside(origin, path.resolve(target)) || inside(origin, await fs.realpath(path.dirname(target)))) return
    await using lock = await Flock.acquire(`config-import:${target}`, {
      dir: path.join(path.dirname(target), ".flynncode-import-locks"),
    })
    if (await stat(path.join(target, marker))) {
      const pending = await readDirectories(journalFor(target))
      if (pending.length) {
        await directoryModes(pending, target, false)
        await fs.rm(journalFor(target), { force: true })
      }
      return target
    }
    const stage = await fs.mkdtemp(path.join(path.dirname(target), ".flynncode-import-"))
    try {
      await validate(origin, new Set(), new Set(), path.join(origin, marker))
      await copy(origin, path.join(stage, "config"), { source: origin, target: path.join(stage, "config") }, true)
    } catch {
      await discard(stage).catch(() => {})
      return
    }
    const journal = journalFor(target)
    const directories: Directory[] = []
    try {
      directories.push(...(await readDirectories(journal)))
      await directoryModes(directories, target, true)
      await publish(path.join(stage, "config"), target, { scratch: stage, journal, directories })
      await directoryModes(
        directories.filter((dir) => dir.file !== target),
        target,
        false,
      )
      await fs.writeFile(path.join(target, marker), "", { flag: "wx", mode: 0o600 })
      await directoryModes(
        directories.filter((dir) => dir.file === target),
        target,
        false,
      )
      await fs.rm(journal, { force: true })
    } catch {
      await directoryModes(directories, target, true).catch(() => {})
      await fs.rm(path.join(target, marker), { force: true }).catch(() => {})
      // Consumers may migrate or install into this copy for their whole lifetime.
      // Keep it private and independent from both source and partially published files.
      return path.join(stage, "config")
    }
    await discard(stage).catch(() => {})
    return target
  } catch {
    return
  }
}

// Validate directory-link graphs before copying: following linked packages must
// not recurse into an ancestor, a sibling cycle, or our own staging directory.
async function validate(source: string, ancestors: Set<string>, seen: Set<string>, ignored: string): Promise<void> {
  if (source === ignored) return
  const resolved = await fs.realpath(source)
  if (!(await fs.stat(resolved)).isDirectory()) return
  if (ancestors.has(resolved)) throw new Error("Config import contains a directory link loop")
  if (seen.has(resolved)) return
  const next = new Set([...ancestors, resolved])
  for (const entry of await fs.readdir(resolved)) {
    await validate(path.join(resolved, entry), next, seen, ignored)
  }
  seen.add(resolved)
}

async function copy(
  source: string,
  target: string,
  root: { source: string; target: string },
  omitMarker = false,
): Promise<void> {
  const info = await fs.lstat(source)
  if (info.isSymbolicLink()) {
    const link = path.resolve(path.dirname(source), await fs.readlink(source))
    const resolved = await fs.realpath(source)
    const internal = inside(root.source, link) ? link : inside(root.source, resolved) ? resolved : undefined
    if (internal) {
      // Relative links preserve package-relative runtime resolution. Rebase
      // absolute internal links too, so neither snapshot nor target aliases source.
      await fs.symlink(
        path.relative(path.dirname(target), path.join(root.target, path.relative(root.source, internal))),
        target,
        (await fs.stat(source)).isDirectory() ? "dir" : "file",
      )
      return
    }
    // External linked packages/skills get a separate materialized subtree;
    // links internal to that subtree are rebased within its independent copy.
    await copy(resolved, target, { source: resolved, target })
    return
  }
  if (info.isDirectory()) {
    await fs.mkdir(target, { mode: info.mode | 0o700 })
    await fs.chmod(target, info.mode | 0o700)
    for (const entry of await fs.readdir(source)) {
      if (omitMarker && entry === marker) continue
      await copy(path.join(source, entry), path.join(target, entry), root)
    }
    await fs.chmod(target, info.mode)
    return
  }
  if (!info.isFile()) throw new Error("Config import contains an unsupported file type")
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL)
  await fs.chmod(target, info.mode)
}

function journalFor(target: string) {
  return path.join(path.dirname(target), ".flynncode-import-locks", `${Hash.fast(target)}.directories.jsonl`)
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

async function publish(
  source: string,
  target: string,
  input: { scratch: string; journal: string; directories: Directory[] },
): Promise<void> {
  const info = await fs.lstat(source)
  if (info.isDirectory()) {
    const existing = await stat(target)
    // Never traverse a destination symlink or replace a user's conflicting file.
    if (existing && !existing.isDirectory()) throw new Error("Config import directory conflict")
    if (!existing) {
      await fs.mkdir(target, { mode: info.mode | 0o700 })
      await fs.chmod(target, info.mode | 0o700)
      const created = await fs.lstat(target)
      const directory = { file: target, mode: info.mode & 0o7777, dev: created.dev, ino: created.ino }
      input.directories.push(directory)
      // Track ownership by inode so retries can finish modes without changing
      // pre-existing user directories or directories replaced between attempts.
      await fs.appendFile(input.journal, `${JSON.stringify(directory)}\n`, { mode: 0o600 })
    }
    for (const entry of (await fs.readdir(source)).sort()) {
      await publish(path.join(source, entry), path.join(target, entry), input)
    }
    return
  }
  if (info.isSymbolicLink()) {
    const link = await fs.readlink(source)
    const existing = await stat(target)
    if (existing) {
      if (!existing.isSymbolicLink()) return
      if ((await fs.readlink(target)) === link) return
      throw new Error("Config import symlink conflict")
    }
    await fs.symlink(link, target, (await fs.stat(source)).isDirectory() ? "dir" : "file")
    return
  }
  if ((await stat(target))?.isSymbolicLink()) throw new Error("Config import file symlink conflict")
  // Publish an independent file atomically. Linking directly from the snapshot
  // would let fallback migrations mutate files already published to the target.
  if (await stat(target)) return
  const file = path.join(input.scratch, randomUUID())
  try {
    await fs.copyFile(source, file, fs.constants.COPYFILE_EXCL)
    await fs.chmod(file, info.mode)
    await fs.link(file, target).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return
      throw error
    })
  } finally {
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

async function readDirectories(file: string): Promise<Directory[]> {
  if (!(await stat(file))) return []
  return (await fs.readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line)
      if (
        typeof value !== "object" ||
        value === null ||
        !("file" in value) ||
        typeof value.file !== "string" ||
        !("mode" in value) ||
        typeof value.mode !== "number" ||
        !("dev" in value) ||
        typeof value.dev !== "number" ||
        !("ino" in value) ||
        typeof value.ino !== "number"
      )
        throw new Error("Invalid config import directory journal")
      return { file: value.file, mode: value.mode, dev: value.dev, ino: value.ino }
    })
}

async function directoryModes(directories: Directory[], target: string, writable: boolean) {
  for (const directory of [...directories].reverse()) {
    if (!inside(path.resolve(target), path.resolve(directory.file)))
      throw new Error("Invalid config import directory path")
    const info = await stat(directory.file)
    if (!info?.isDirectory() || info.dev !== directory.dev || info.ino !== directory.ino) continue
    // A different mode is a user edit, not unfinished import bookkeeping.
    const mode = info.mode & 0o7777
    if (mode !== directory.mode && mode !== (directory.mode | 0o700)) continue
    await fs.chmod(directory.file, writable ? directory.mode | 0o700 : directory.mode)
  }
}

async function discard(dir: string): Promise<void> {
  await fs.chmod(dir, (await fs.lstat(dir)).mode | 0o700)
  for (const entry of await fs.readdir(dir)) {
    const file = path.join(dir, entry)
    if ((await fs.lstat(file)).isDirectory()) await discard(file)
  }
  await fs.rm(dir, { recursive: true, force: true })
}

function stat(file: string) {
  return fs.lstat(file).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
    throw error
  })
}
