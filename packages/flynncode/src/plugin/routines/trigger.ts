import { readdir, readFile, stat } from "node:fs/promises"
import path from "path"
import { Global } from "@flynncode/core/global"
import { Flock } from "@flynncode/core/util/flock"
import { Octokit } from "@octokit/rest"
import { Effect } from "effect"
import type { Routine, TriggerGithub } from "./parse"

const PREFIX = "[routines]"
const TRIGGER_STATE_FILE = path.join(Global.Path.state, "routines-trigger-state.json")
const GITHUB_POLL_MS = 5 * 60_000

// Fires routines whose watched files changed since the last observed baseline.
// The first sighting of a routine records a baseline instead of firing, and
// changes made while the routine's own session is still running (`busy`) are
// absorbed into the baseline so a run never re-triggers itself. Each directory
// is scanned once per call, and only matched files are stat'ed.
export async function fileTriggersDue(
  routines: Routine[],
  busy: ReadonlySet<string>,
  stateFile: string = TRIGGER_STATE_FILE,
) {
  const watched = routines.filter((routine) => routine.enabled && routine.trigger?.files?.length)
  const skipped = watched.filter((routine) => !routine.directory)
  if (skipped.length > 0)
    console.warn(`${PREFIX} file triggers need a directory; skipping ${skipped.map((routine) => routine.id).join(", ")}`)
  const located = watched.flatMap((routine) => (routine.directory ? [{ routine, directory: resolveDirectory(routine.directory) }] : []))
  if (located.length === 0) return []
  const scans = new Map(
    [...new Set(located.map((entry) => entry.directory))].map((directory) => [directory, scanFiles(directory)]),
  )
  const mtimes = new Map<string, Promise<number>>()
  const newest = await Promise.all(
    located.map(async (entry) => {
      const globs = (entry.routine.trigger?.files ?? []).map((pattern) => new Bun.Glob(pattern))
      const files = (await scans.get(entry.directory)) ?? []
      const times = await Promise.all(
        files
          .filter((file) => globs.some((glob) => glob.match(file)))
          .map((file) => {
            const full = path.join(entry.directory, file)
            const cached = mtimes.get(full) ?? stat(full).then((info) => info.mtimeMs, () => 0)
            mtimes.set(full, cached)
            return cached
          }),
      )
      return { routine: entry.routine, newest: Math.max(0, ...times) }
    }),
  )
  return updateTriggerState(stateFile, (state) =>
    newest.flatMap((entry) => {
      const previous = state[entry.routine.id]
      const baseline = previous?.filesSeenAt
      state[entry.routine.id] = { ...previous, filesSeenAt: Math.max(baseline ?? 0, entry.newest) }
      if (baseline === undefined) return []
      if (busy.has(entry.routine.id)) return []
      return entry.newest > baseline ? [entry.routine] : []
    }),
  )
}

export function resolveDirectory(directory: string) {
  if (directory.startsWith("~/")) return path.join(Global.Path.home, directory.slice(2))
  return directory
}

type TriggerState = Record<string, { seenAt?: string; checkedAt?: string; filesSeenAt?: number }>

export async function githubDue(routine: Routine, token: string | undefined, stateFile: string = TRIGGER_STATE_FILE) {
  const github = routine.trigger?.github
  if (!github || !routine.enabled) return false
  if (!token) {
    console.warn(`${PREFIX} skipping github trigger without GITHUB_TOKEN`)
    return false
  }
  const now = Date.now()
  const entry = (await readTriggerState(stateFile))[routine.id]
  if (entry?.checkedAt && now - new Date(entry.checkedAt).getTime() < GITHUB_POLL_MS) return false
  const newest = await newestUpdatedAt(github, token).catch(() => undefined)
  return updateTriggerState(stateFile, (state) => {
    const previous = state[routine.id]
    state[routine.id] = { ...previous, seenAt: newest ?? previous?.seenAt, checkedAt: new Date(now).toISOString() }
    if (!newest) return false
    // First poll records a baseline; only later activity fires the routine.
    if (!previous?.seenAt) return false
    return new Date(newest).getTime() > new Date(previous.seenAt).getTime()
  })
}

function updateTriggerState<T>(stateFile: string, update: (state: TriggerState) => T) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Flock.effect(`routines-trigger-state:${stateFile}`, { staleMs: 10_000, timeoutMs: 30_000 })
      const state = yield* Effect.promise(() => readTriggerState(stateFile))
      const result = update(state)
      yield* Effect.promise(() => Bun.write(stateFile, JSON.stringify(state)))
      return result
    }).pipe(Effect.scoped),
  )
}

async function newestUpdatedAt(github: TriggerGithub, token: string) {
  const octokit = new Octokit({ auth: token })
  if (github.event === "pr") {
    const listed = await octokit.pulls.list({
      owner: github.owner,
      repo: github.repo,
      sort: "updated",
      direction: "desc",
      per_page: 1,
    })
    return listed.data[0]?.updated_at as string | undefined
  }
  const listed = await octokit.issues.listForRepo({
    owner: github.owner,
    repo: github.repo,
    sort: "updated",
    direction: "desc",
    per_page: 1,
  })
  return listed.data[0]?.updated_at as string | undefined
}

async function readTriggerState(file: string): Promise<TriggerState> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as TriggerState
  } catch {
    return {}
  }
}

async function scanFiles(directory: string) {
  const found: string[] = []
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      found.push(path.relative(directory, full).split(path.sep).join("/"))
    }
  }
  await walk(directory)
  return found
}
