export * as BackgroundRegistry from "./registry"

import fs from "fs/promises"
import path from "path"

export type Entry = { id: string; sessionID: string; pid: number; cmdline: string; startedAt: number }
export type Owner = { pid: number; start: string }
export type Skipped = Entry & { reason: string }
type Kill = (pgid: number, signal: NodeJS.Signals) => void
type Outcome = { status: "killed" } | { status: "skipped"; reason: string; resolved: boolean }

const TERM_WAIT_MS = 2_000
const POLL_MS = 50
// `<pid>-<start>.json`; a `t` start is a wall-clock fallback for platforms without /proc.
const OWNER_FILE = /^(\d+)-(t?\d+)\.json$/

// The server exits without running finalizers, so these files are the only record of background process groups
// that outlive it. Every mutation of this server's file goes through one chain so concurrent adds and removes
// cannot lose entries.
let chain: Promise<unknown> = Promise.resolve()
let current: Promise<Owner> | undefined

function serialize<T>(fn: () => Promise<T>) {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

// Several servers (desktop sidecar, CLI/TUI, dev servers) share one state directory, so each writes only its own
// file. The start time is part of the name so a recycled pid is a different owner.
export function owner() {
  current ??= stat(process.pid, 22).then((start) => ({ pid: process.pid, start: start ?? `t${Date.now()}` }))
  return current
}

export function add(dir: string, entry: Entry) {
  return serialize(async () => {
    const file = await ownFile(dir)
    await write(file, [...(await load(file)), entry])
  })
}

export function remove(dir: string, id: string) {
  return serialize(async () => {
    const file = await ownFile(dir)
    await write(
      file,
      (await load(file)).filter((item) => item.id !== id),
    )
  })
}

export function list(dir: string) {
  return serialize(async () => load(await ownFile(dir)).catch(() => [] as Entry[]))
}

export async function cmdline(pid: number) {
  if (process.platform !== "linux") return undefined
  const raw = await Bun.file(`/proc/${pid}/cmdline`)
    .text()
    .catch(() => undefined)
  // Empty for zombies and for children that have not exec'd yet: nothing to match against.
  return raw?.replaceAll("\0", " ").trim() || undefined
}

// Cleans up after servers that died: live servers' files are never read or written. A recorded pid may have been
// recycled by an unrelated process, so a process is signalled only when its live cmdline still matches; where
// /proc is unavailable nothing can be verified, so nothing is killed. A dead server's file is deleted once every
// entry is resolved, otherwise it keeps the unresolved entries for the next start.
export async function reap(dir: string, input?: { kill?: Kill }) {
  const kill = input?.kill ?? signalGroup
  const self = await owner()
  const result = { killed: [] as Entry[], skipped: [] as Skipped[] }
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const match = OWNER_FILE.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === self.pid && match[2] === self.start) continue
    if (await ownerAlive(pid, match[2])) continue
    const file = path.join(dir, name)
    // Unreadable: leave it for a later start rather than guess.
    const entries = await load(file).catch(() => undefined)
    if (!entries) continue
    const unresolved: Entry[] = []
    for (const entry of entries) {
      const outcome = await terminate(entry, kill).catch(
        (error: unknown): Outcome => ({ status: "skipped", reason: String(error), resolved: false }),
      )
      if (outcome.status === "killed") result.killed.push(entry)
      if (outcome.status === "skipped") result.skipped.push({ ...entry, reason: outcome.reason })
      if (outcome.status === "skipped" && !outcome.resolved) unresolved.push(entry)
    }
    if (unresolved.length === entries.length) continue
    if (unresolved.length > 0) {
      await write(file, unresolved)
      continue
    }
    await fs.rm(file, { force: true })
    await fs.rm(`${file}.${pid}.tmp`, { force: true })
  }
  return result
}

async function terminate(entry: Entry, kill: Kill): Promise<Outcome> {
  if (entry.pid <= 1) return { status: "skipped", reason: "invalid pid", resolved: true }
  if ((await cmdline(entry.pid)) !== entry.cmdline) return { status: "skipped", reason: "not running", resolved: true }
  // Still running with the recorded cmdline, so the record stays for a later server that may reap it.
  if (entry.pid === process.pid || entry.pid === process.ppid)
    return { status: "skipped", reason: "protected process", resolved: false }
  // Signalling a group is only safe when the pid leads its own; otherwise -pid would target a different group.
  if (Number(await stat(entry.pid, 5)) !== entry.pid) {
    signalPid(entry.pid, "SIGTERM")
    await waitWhile(async () => (await cmdline(entry.pid)) === entry.cmdline)
    if ((await cmdline(entry.pid)) === entry.cmdline) signalPid(entry.pid, "SIGKILL")
    return { status: "killed" }
  }
  if (entry.pid === Number(await stat(process.pid, 5)))
    return { status: "skipped", reason: "own process group", resolved: false }
  kill(entry.pid, "SIGTERM")
  // The leader may exit while members that ignore SIGTERM live on, so wait on the whole group. Linux does not
  // hand out a pid that is still in use as a pgid, so a live -pid is still the same group.
  await waitWhile(async () => exists(-entry.pid))
  if (exists(-entry.pid)) kill(entry.pid, "SIGKILL")
  return { status: "killed" }
}

async function waitWhile(condition: () => Promise<boolean>) {
  const deadline = Date.now() + TERM_WAIT_MS
  while (Date.now() < deadline && (await condition())) await Bun.sleep(POLL_MS)
}

async function ownerAlive(pid: number, start: string) {
  if (!exists(pid)) return false
  // Without a /proc start time the owner cannot be told apart from a recycled pid, so a live pid counts as alive.
  if (start.startsWith("t")) return true
  const live = await stat(pid, 22)
  return live === undefined || live === start
}

// Field numbers follow proc(5). The comm field may contain spaces and parens, so fields are split after the last
// ")", where field 3 begins.
async function stat(pid: number, field: number) {
  const text = await Bun.file(`/proc/${pid}/stat`)
    .text()
    .catch(() => undefined)
  if (!text) return undefined
  return text
    .slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(" ")[field - 3]
}

// Signal 0 probe: EPERM still means something is running under that pid or pgid.
function exists(target: number) {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  ignoreGone(() => process.kill(-pgid, signal))
}

function signalPid(pid: number, signal: NodeJS.Signals) {
  ignoreGone(() => process.kill(pid, signal))
}

function ignoreGone(fn: () => void) {
  try {
    fn()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

async function ownFile(dir: string) {
  const self = await owner()
  return path.join(dir, `${self.pid}-${self.start}.json`)
}

// Throws on anything but a missing file, so a caller never overwrites a file it could not read.
async function load(file: string) {
  const text = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]"
    throw error
  })
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error(`background shell registry ${file} is not an array`)
  return parsed.filter(isEntry)
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === "string" &&
    typeof item.sessionID === "string" &&
    typeof item.pid === "number" &&
    typeof item.cmdline === "string" &&
    typeof item.startedAt === "number"
  )
}

async function write(file: string, entries: Entry[]) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await Bun.write(temp, JSON.stringify(entries))
  await fs.rename(temp, file)
}
