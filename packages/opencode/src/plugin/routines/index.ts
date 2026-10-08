import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { Effect } from "effect"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { dueRoutines } from "./due"
import { parseRoutines, type Routine, type RoutineRunSummary } from "./parse"
import { triggerDue } from "./trigger"

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
    return []
  }
  return parsed.value.routines
}

async function readFileRoutines() {
  const file = Bun.file(FILE)
  if (!(await file.exists())) return []
  const parsed = parseRoutines(parse(await file.text()))
  if (!parsed.ok) {
    console.warn(`${PREFIX} invalid file:\n- ${parsed.errors.join("\n- ")}`)
    return []
  }
  return parsed.value.routines
}

export async function loadRoutines() {
  const fromConfig = await readConfigRoutines()
  if (fromConfig) return { source: "config" as const, routines: fromConfig }
  return { source: "file" as const, routines: await readFileRoutines() }
}

export const markRanEffect = Effect.fn("Routines.markRan")(function* (
  loaded: { source: "config" | "file"; routines: Routine[] },
  runs: { id: string; summary: RoutineRunSummary }[],
  now: Date,
) {
  // Serialize read-modify-write across processes: reload state under a lock so
  // another scheduler's markRan (or the settings UI) cannot lose our lastRun
  // or override user edits.
  yield* Flock.effect(`routines:${configFile()}`, { staleMs: 10_000, timeoutMs: 30_000 })
  const fresh = yield* Effect.promise(() => loadRoutines())
  const byID = new Map(fresh.routines.map((routine) => [routine.id, routine]))
  const summaries = new Map(runs.map((run) => [run.id, run.summary]))
  const next = loaded.routines.map((routine) => {
    const current = byID.get(routine.id) ?? routine
    const summary = summaries.get(routine.id)
    if (!summary) return routine
    return { ...current, lastRun: now.toISOString(), recentRuns: [...(current.recentRuns ?? []), summary].slice(-10) }
  })
  const storedRoutines = next.map(stored)
  if (fresh.source === "file") {
    yield* Effect.promise(() => Bun.write(FILE, JSON.stringify({ routines: storedRoutines }, null, 2)))
    return next
  }
  const text = yield* Effect.promise(() => Bun.file(configFile()).text())
  const edits = modify(text, ["routines"], storedRoutines, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
  yield* Effect.promise(() => Bun.write(configFile(), applyEdits(text, edits)))
  return next
})

export async function markRan(
  loaded: { source: "config" | "file"; routines: Routine[] },
  runs: { id: string; summary: RoutineRunSummary }[],
  now: Date,
) {
  return Effect.runPromise(Effect.scoped(markRanEffect(loaded, runs, now)))
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

async function runOne(client: Client, directory: string, routine: Routine) {
  const created = await client.session.create({
    body: { title: routine.name },
    query: { directory },
  })
  const sessionID = created.data?.id
  if (!sessionID) return { sessionID: undefined }
  await client.session.promptAsync({
    path: { id: sessionID },
    query: { directory },
    body: {
      agent: "build",
      parts: [{ type: "text", text: routine.prompt }],
    },
  })
  return { sessionID }
}

export function startScheduler(client: Client, directory: string) {
  // Reentrancy guard: a tick whose session creation outlasts the 30s
  // interval must not let the next tick re-fire the same routines.
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const loaded = await loadRoutines()
      const due = dueRoutines(loaded.routines, new Date())
      const dueIDs = new Set(due.map((routine) => routine.id))
      const polled = await Promise.all(
        loaded.routines.map(async (routine) => {
          if (dueIDs.has(routine.id)) return undefined
          const fired = await triggerDue(routine, directory).catch(() => false)
          return fired ? routine : undefined
        }),
      )
      for (const routine of polled) {
        if (routine && !dueIDs.has(routine.id)) {
          dueIDs.add(routine.id)
          due.push(routine)
        }
      }
      if (due.length === 0) return
      // Record each routine individually so one failure does not make every
      // later tick re-fire the whole batch.
      const results = await Promise.allSettled(
        due.map(async (routine) => {
          const startedAt = new Date()
          try {
            const { sessionID } = await runOne(client, directory, routine)
            const endedAt = new Date()
            await recordRoutineRun({
              routineId: routine.id,
              sessionID,
              agent: "build",
              startedAt: startedAt.toISOString(),
              endedAt: endedAt.toISOString(),
              state: "ok",
            })
            const saved = await markRan(
              loaded,
              [
                {
                  id: routine.id,
                  summary: {
                    sessionID,
                    startedAt: startedAt.toISOString(),
                    endedAt: endedAt.toISOString(),
                    state: "ok",
                  },
                },
              ],
              endedAt,
            )
            return saved
          } catch (error) {
            const endedAt = new Date()
            const message = error instanceof Error ? error.message : String(error)
            await recordRoutineRun({
              routineId: routine.id,
              agent: "build",
              startedAt: startedAt.toISOString(),
              endedAt: endedAt.toISOString(),
              state: "error",
              error: message,
            }).catch((recordError) => console.warn(`${PREFIX} failed to record run`, recordError))
            await markRan(
              loaded,
              [
                {
                  id: routine.id,
                  summary: {
                    startedAt: startedAt.toISOString(),
                    endedAt: endedAt.toISOString(),
                    state: "error",
                    error: message,
                  },
                },
              ],
              endedAt,
            ).catch((markError) => console.warn(`${PREFIX} failed to record run`, markError))
            throw error
          }
        }),
      )
      for (const result of results) {
        if (result.status !== "rejected") continue
        console.warn(`${PREFIX} scheduled routine run failed`, result.reason)
      }
    } catch (error) {
      console.warn(`${PREFIX} scheduler tick failed`, error)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), 30_000)
  return () => clearInterval(timer)
}

export const RoutinesPlugin = async (input: PluginInput): Promise<Hooks> => {
  const stopScheduler = startScheduler(input.client, input.directory)
  return {
    dispose: async () => stopScheduler(),
  }
}

export default {
  id: "routines",
  server: RoutinesPlugin,
}
