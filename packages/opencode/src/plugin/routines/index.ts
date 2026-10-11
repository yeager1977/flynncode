import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { Effect } from "effect"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { dueRoutines } from "./due"
import { parseRoutines, type Routine, type RoutineRunSummary } from "./parse"
import { fileTriggersDue, githubDue, resolveDirectory } from "./trigger"

// Mirrors globalConfigFile() precedence so we patch the file OpenCode loads.
const CONFIG_CANDIDATES = ["opencode.jsonc", "opencode.json", "config.json"]
const FILE = path.join(Global.Path.config, "routines.jsonc")
const PREFIX = "[routines]"

type Client = PluginInput["client"]

function stored(routine: Routine) {
  return {
    id: routine.id,
    name: routine.name,
    prompt: routine.prompt,
    enabled: routine.enabled,
    lastRun: routine.lastRun,
    createdAt: routine.createdAt,
    directory: routine.directory,
    recentRuns: routine.recentRuns,
    trigger: routine.trigger,
    schedule: routine.dailyAt
      ? { dailyAt: routine.dailyAt }
      : routine.interval
        ? { interval: routine.interval }
        : routine.rrule
          ? { rrule: routine.rrule }
          : undefined,
  }
}

function configFile() {
  for (const name of CONFIG_CANDIDATES) {
    const candidate = path.join(Global.Path.config, name)
    if (Bun.file(candidate).size > 0) return candidate
  }
  return path.join(Global.Path.config, CONFIG_CANDIDATES[0] ?? "opencode.jsonc")
}

async function readConfigRoutines() {
  const file = Bun.file(configFile())
  if (!(await file.exists())) return
  const data = parse(await file.text()) as { routines?: unknown }
  if (!data || data.routines === undefined) return
  const parsed = parseRoutines(data.routines)
  if (!parsed.ok) {
    console.warn(`${PREFIX} invalid config:\n- ${parsed.errors.join("\n- ")}`)
    return { valid: false, routines: [] }
  }
  return { valid: true, routines: parsed.value.routines }
}

async function readFileRoutines() {
  const file = Bun.file(FILE)
  if (!(await file.exists())) return { valid: true, routines: [] }
  const parsed = parseRoutines(parse(await file.text()))
  if (!parsed.ok) {
    console.warn(`${PREFIX} invalid file:\n- ${parsed.errors.join("\n- ")}`)
    return { valid: false, routines: [] }
  }
  return { valid: true, routines: parsed.value.routines }
}

export async function loadRoutines() {
  const fromConfig = await readConfigRoutines()
  if (fromConfig) return { source: "config" as const, ...fromConfig }
  return { source: "file" as const, ...(await readFileRoutines()) }
}

export const markRanEffect = Effect.fn("Routines.markRan")(function* (
  runs: { id: string; summary: RoutineRunSummary }[],
  now: Date,
) {
  // Serialize read-modify-write across processes and rebuild from the freshly
  // loaded list, so Settings edits and other routines' lastRun made while this
  // tick ran survive; only this tick's runs (and missing createdAt stamps)
  // change.
  yield* Flock.effect(`routines:${configFile()}`, { staleMs: 10_000, timeoutMs: 30_000 })
  const fresh = yield* Effect.promise(() => loadRoutines())
  if (!fresh.valid) return fresh.routines
  const summaries = new Map(runs.map((run) => [run.id, run.summary]))
  const next = fresh.routines.map((routine) => {
    const summary = summaries.get(routine.id)
    const created = { ...routine, createdAt: routine.createdAt ?? now.toISOString() }
    if (!summary) return created
    return { ...created, lastRun: now.toISOString(), recentRuns: [...(routine.recentRuns ?? []), summary].slice(-10) }
  })
  if (runs.length === 0 && fresh.routines.every((routine) => routine.createdAt)) return next
  // Same shape the Settings writer (routinesToConfig) stores: config.routines
  // is an object wrapping the list, as the config schema requires.
  const value = { routines: next.map(stored) }
  if (fresh.source === "file") {
    yield* Effect.promise(() => Bun.write(FILE, JSON.stringify(value, null, 2)))
    return next
  }
  const text = yield* Effect.promise(() => Bun.file(configFile()).text())
  const edits = modify(text, ["routines"], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
  yield* Effect.promise(() => Bun.write(configFile(), applyEdits(text, edits)))
  return next
})

export async function markRan(runs: { id: string; summary: RoutineRunSummary }[], now: Date) {
  return Effect.runPromise(Effect.scoped(markRanEffect(runs, now)))
}

const RUNS_FILE = path.join(Global.Path.state, "routines-runs.jsonl")
const MAX_RUNS = 200

export type RoutineRun = {
  routineId: string
  sessionID?: string
  agent: string
  startedAt: string
  endedAt: string
  state: "ok" | "error"
  error?: string
}

export function parseRunRecords(text: string): RoutineRun[] {
  return text
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed) return []
      try {
        const parsed = JSON.parse(trimmed) as RoutineRun
        if (typeof parsed !== "object" || parsed === null || typeof parsed.routineId !== "string") return []
        return [parsed]
      } catch {
        // Skip corrupt lines instead of failing the whole rewrite.
        return []
      }
    })
    .slice(-MAX_RUNS)
}

// History readers skip the flock: the writer serializes its own
// read-append-rewrite, so readers just need a consistent snapshot.
export async function readRoutineRuns(file: string = RUNS_FILE) {
  const runs = Bun.file(file)
  if (!(await runs.exists())) return []
  return parseRunRecords(await runs.text())
}

export async function recordRoutineRun(record: RoutineRun, file: string = RUNS_FILE) {
  // Serialize read-append-rewrite across concurrent runs (Promise.allSettled
  // scheduler) so parallel records cannot drop each other's writes.
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Flock.effect(`routines-runs:${file}`, { staleMs: 10_000, timeoutMs: 30_000 })
      const existing = (yield* Effect.promise(() => Bun.file(file).exists())) ? yield* Effect.promise(() => Bun.file(file).text()) : ""
      const records = [...parseRunRecords(existing), record].slice(-MAX_RUNS)
      yield* Effect.promise(() => Bun.write(file, records.map((row) => JSON.stringify(row)).join("\n") + "\n"))
      return records
    }).pipe(Effect.scoped),
  )
}

const SCHEDULER_LOCK = "routines:scheduler"
const RUN_TIMEOUT_MS = 60_000

// Process-global: every instance that loads the plugin registers its client,
// but only one timer ticks per process. Routines are user-global, so ticking
// per instance would run them once per open project.
const scheduler = {
  clients: new Set<Client>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  running: false,
  // Routine sessions still working, keyed by routine ID, so file triggers can
  // ignore the routine's own edits. Process-local: a run started by another
  // process is not tracked here.
  active: new Map<string, { sessionID: string; directory: string }>(),
}

export function startScheduler(client: Client) {
  scheduler.clients.add(client)
  scheduler.timer ??= setInterval(() => void scheduledTick(), 30_000)
  return () => {
    scheduler.clients.delete(client)
    if (scheduler.clients.size > 0 || !scheduler.timer) return
    clearInterval(scheduler.timer)
    scheduler.timer = undefined
  }
}

async function scheduledTick() {
  const client = scheduler.clients.values().next().value
  // Reentrancy guard: a tick whose session creation outlasts the 30s interval
  // must not let the next tick re-fire the same routines.
  if (scheduler.running || !client) return
  scheduler.running = true
  await runTick(client)
    .catch((error) => console.warn(`${PREFIX} scheduler tick failed`, error))
    .finally(() => {
      scheduler.running = false
    })
}

// Checks, runs, and marks due routines while holding a cross-process lock, so
// two processes (or two ticks) never run the same occurrence: the second one
// reloads after the first has written lastRun and trigger baselines.
// Routines without a `directory` run in the user's home directory.
export async function runTick(client: Client, now = new Date()) {
  await using _ = await Flock.acquire(SCHEDULER_LOCK, { staleMs: 60_000, timeoutMs: 20_000 })
  const loaded = await loadRoutines()
  const busy = await busyRoutines(client)
  const due = dueRoutines(loaded.routines, now)
  const dueIDs = new Set(due.map((routine) => routine.id))
  const filed = await fileTriggersDue(
    loaded.routines.filter((routine) => !dueIDs.has(routine.id)),
    busy,
  ).catch((error) => {
    console.warn(`${PREFIX} file trigger check failed`, error)
    return []
  })
  const firedIDs = new Set([...dueIDs, ...filed.map((routine) => routine.id)])
  const token = process.env.GITHUB_TOKEN
  const polled = await Promise.all(
    loaded.routines
      .filter((routine) => routine.trigger?.github && !firedIDs.has(routine.id))
      .map((routine) => githubDue(routine, token).then((fired) => (fired ? [routine] : []), () => [])),
  )
  const fired = [...due, ...filed, ...polled.flat()]
  const runs = await Promise.all(fired.map((routine) => runRoutine(client, routine)))
  await markRan(runs, new Date())
  return runs
}

async function busyRoutines(client: Client) {
  const ids = await Promise.all(
    [...scheduler.active].map(async ([id, run]) => {
      const status = await client.session
        .status({ query: { directory: run.directory } })
        .then((response) => response.data?.[run.sessionID], () => undefined)
      // Still count the tick that first sees the session idle, so edits made at
      // the very end of the run are absorbed rather than re-firing it.
      if (!status || status.type === "idle") scheduler.active.delete(id)
      return id
    }),
  )
  return new Set(ids)
}

async function runRoutine(client: Client, routine: Routine) {
  const directory = routine.directory ? resolveDirectory(routine.directory) : Global.Path.home
  const startedAt = new Date().toISOString()
  const result = await runOne(client, directory, routine).then(
    (sessionID) => ({ sessionID, error: undefined }),
    (error) => ({ sessionID: undefined, error: error instanceof Error ? error.message : String(error) }),
  )
  const endedAt = new Date().toISOString()
  if (result.sessionID) scheduler.active.set(routine.id, { sessionID: result.sessionID, directory })
  if (result.error) console.warn(`${PREFIX} scheduled routine ${routine.id} failed: ${result.error}`)
  const state = result.error ? ("error" as const) : ("ok" as const)
  await recordRoutineRun({
    routineId: routine.id,
    sessionID: result.sessionID,
    agent: "build",
    startedAt,
    endedAt,
    state,
    error: result.error,
  }).catch((error) => console.warn(`${PREFIX} failed to record run`, error))
  return { id: routine.id, summary: { sessionID: result.sessionID, startedAt, endedAt, state, error: result.error } }
}

async function runOne(client: Client, directory: string, routine: Routine) {
  const created = await client.session.create({
    body: { title: routine.name },
    query: { directory },
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  })
  const sessionID = created.data?.id
  if (!sessionID) throw new Error("failed to create session")
  await client.session.promptAsync({
    path: { id: sessionID },
    query: { directory },
    body: {
      agent: "build",
      parts: [{ type: "text", text: routine.prompt }],
    },
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  })
  return sessionID
}

export const RoutinesPlugin = async (input: PluginInput): Promise<Hooks> => {
  const stopScheduler = startScheduler(input.client)
  return {
    dispose: async () => stopScheduler(),
  }
}

export default {
  id: "routines",
  server: RoutinesPlugin,
}
