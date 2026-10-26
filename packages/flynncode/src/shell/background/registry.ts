export * as BackgroundRegistry from "./registry"

import fs from "fs/promises"
import path from "path"

export type Entry = { id: string; sessionID: string; pid: number; cmdline: string; startedAt: number }

const TERM_WAIT_MS = 2_000
const POLL_MS = 50

// The server exits without running finalizers, so this file is the only record of background process groups
// that outlive it. Every mutation goes through one chain so concurrent adds and removes cannot lose entries.
let chain: Promise<unknown> = Promise.resolve()

function serialize<T>(fn: () => Promise<T>) {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

export function add(file: string, entry: Entry) {
  return serialize(async () => write(file, [...(await read(file)), entry]))
}

export function remove(file: string, id: string) {
  return serialize(async () =>
    write(
      file,
      (await read(file)).filter((item) => item.id !== id),
    ),
  )
}

export function list(file: string) {
  return serialize(() => read(file))
}

export async function cmdline(pid: number) {
  if (process.platform !== "linux") return undefined
  const raw = await Bun.file(`/proc/${pid}/cmdline`)
    .text()
    .catch(() => undefined)
  // Empty for zombies and for children that have not exec'd yet: nothing to match against.
  return raw?.replaceAll("\0", " ").trim() || undefined
}

// A recorded pid may have been recycled by an unrelated process after a crash, so a group is signalled only
// when the live cmdline still matches. Where /proc is unavailable nothing can be verified, so nothing is killed.
export function reap(file: string, input?: { kill?: (pgid: number, signal: NodeJS.Signals) => void }) {
  const kill = input?.kill ?? signalGroup
  return serialize(async () => {
    const entries = await read(file)
    const result = { killed: [] as Entry[], skipped: [] as Entry[] }
    for (const entry of entries) {
      if (await terminate(entry, kill)) result.killed.push(entry)
      else result.skipped.push(entry)
    }
    await write(file, [])
    return result
  })
}

async function terminate(entry: Entry, kill: (pgid: number, signal: NodeJS.Signals) => void) {
  if (entry.pid <= 1 || entry.pid === process.pid || entry.pid === process.ppid) return false
  if ((await cmdline(entry.pid)) !== entry.cmdline) return false
  // Signalling a group is only safe when the pid leads its own; otherwise -pid would target a different group.
  const leader = (await processGroup(entry.pid)) === entry.pid
  const send = (signal: NodeJS.Signals) => (leader ? kill(entry.pid, signal) : signalPid(entry.pid, signal))
  send("SIGTERM")
  const deadline = Date.now() + TERM_WAIT_MS
  while (Date.now() < deadline && (await cmdline(entry.pid)) === entry.cmdline) await Bun.sleep(POLL_MS)
  if ((await cmdline(entry.pid)) === entry.cmdline) send("SIGKILL")
  return true
}

// Field 5 of /proc/<pid>/stat; the comm field may contain spaces and parens, so parse after the last ")".
async function processGroup(pid: number) {
  const stat = await Bun.file(`/proc/${pid}/stat`)
    .text()
    .catch(() => undefined)
  if (!stat) return undefined
  const pgrp = Number(
    stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(" ")[2],
  )
  return Number.isInteger(pgrp) ? pgrp : undefined
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

async function read(file: string) {
  const parsed = await Bun.file(file)
    .json()
    .catch(() => undefined)
  return Array.isArray(parsed) ? parsed.filter(isEntry) : []
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
