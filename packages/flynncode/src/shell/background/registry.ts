export * as BackgroundRegistry from "./registry"

import fs from "fs/promises"
import path from "path"

// `pgid` is the leader's pid (it leads its own group because it is spawned detached); `start` is the group's start
// time from `groupStart`; `command` is informational only.
export type Entry = { id: string; sessionID: string; pgid: number; start: string; startedAt: number; command: string }
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

// The group's identity is the leader's start time, read right after spawn while the leader is still a process.
// A leader that already exited is identified by its earliest surviving member: no later process can predate the
// group. Undefined where /proc is unavailable or the whole group is gone.
export async function groupStart(pgid: number) {
  const leader = await stat(pgid, 22)
  if (leader !== undefined) return leader
  const starts = await memberStarts(pgid)
  if (starts.length === 0) return undefined
  return String(Math.min(...starts))
}

// Cleans up after servers that died: live servers' files are never read or written. A recorded pgid may have been
// recycled by an unrelated process, so a group is signalled only when its start time still matches; where /proc is
// unavailable nothing can be verified, so nothing is killed. A dead server's file is deleted once every
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
  if (entry.pgid <= 1) return { status: "skipped", reason: "invalid pid", resolved: true }
  if (!(await ours(entry))) return { status: "skipped", reason: "not running", resolved: true }
  // Still running, so the record stays for a later server that may reap it.
  if (entry.pgid === process.pid || entry.pgid === process.ppid)
    return { status: "skipped", reason: "protected process", resolved: false }
  if (entry.pgid === Number(await stat(process.pid, 5)))
    return { status: "skipped", reason: "own process group", resolved: false }
  // A matching pid that does not lead a group (never true for a detached spawn) has nothing to signal as -pgid.
  if (!exists(-entry.pgid)) return { status: "skipped", reason: "not running", resolved: true }
  kill(entry.pgid, "SIGTERM")
  // The leader may exit while members that ignore SIGTERM live on, so wait on the whole group. Linux does not
  // hand out a pid that is still in use as a pgid, so a live -pgid is still the same group.
  await waitWhile(async () => exists(-entry.pgid))
  if (exists(-entry.pgid)) kill(entry.pgid, "SIGKILL")
  return { status: "killed" }
}

// A live leader must still have the recorded start time; a different one means the pid was recycled. A dead
// leader's group lives on in its members, and a pgid cannot be reused while any member exists, so members that
// started no earlier than the group belong to it.
async function ours(entry: Entry) {
  const leader = await stat(entry.pgid, 22)
  if (leader !== undefined) return leader === entry.start
  return (await memberStarts(entry.pgid)).some((start) => start >= Number(entry.start))
}

async function memberStarts(pgid: number) {
  const names = await fs.readdir("/proc").catch(() => [] as string[])
  const stats = await Promise.all(names.filter((name) => /^\d+$/.test(name)).map((name) => fields(Number(name))))
  return stats
    .filter((item): item is string[] => item !== undefined && Number(item[2]) === pgid)
    .map((item) => Number(item[19]))
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

// Field numbers follow proc(5).
async function stat(pid: number, field: number) {
  return (await fields(pid))?.[field - 3]
}

// The comm field may contain spaces and parens, so fields are split after the last ")", where field 3 begins.
async function fields(pid: number) {
  const text = await Bun.file(`/proc/${pid}/stat`)
    .text()
    .catch(() => undefined)
  if (!text) return undefined
  return text
    .slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(" ")
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
  try {
    process.kill(-pgid, signal)
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
    typeof item.pgid === "number" &&
    typeof item.start === "string" &&
    /^\d+$/.test(item.start) &&
    typeof item.startedAt === "number" &&
    typeof item.command === "string"
  )
}

async function write(file: string, entries: Entry[]) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await Bun.write(temp, JSON.stringify(entries))
  await fs.rename(temp, file)
}
