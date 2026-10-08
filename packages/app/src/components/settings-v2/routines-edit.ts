export type StoredRoutineRun = {
  sessionID?: string
  startedAt: string
  endedAt: string
  state: "ok" | "error"
  error?: string
}

export type StoredRoutine = {
  id: string
  name: string
  prompt: string
  enabled: boolean
  lastRun?: string
  dailyAt?: string
  interval?: string
  rrule?: string
  recentRuns?: StoredRoutineRun[]
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const INTERVALS = new Set(["15m", "1h", "6h", "1d", "1w"])

// Mirrors the backend readRrule shape check: a bare FREQ value or FREQ plus
// semicolon-separated parts. The backend RRule library is the final arbiter.
export function isValidRrule(value: string) {
  return /^FREQ=[A-Z]+(;|$)/.test(value)
}

export function routinesFromConfig(raw: unknown): StoredRoutine[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  const list = (raw as { routines?: unknown }).routines
  if (!Array.isArray(list)) return []
  return list.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.prompt !== "string") return []
    const schedule = row.schedule
    const dailyAt =
      schedule && typeof schedule === "object" && !Array.isArray(schedule)
        ? (schedule as { dailyAt?: unknown }).dailyAt
        : undefined
    const interval =
      schedule && typeof schedule === "object" && !Array.isArray(schedule)
        ? (schedule as { interval?: unknown }).interval
        : undefined
    const rrule =
      schedule && typeof schedule === "object" && !Array.isArray(schedule)
        ? (schedule as { rrule?: unknown }).rrule
        : undefined
    return [
      {
        id: row.id,
        name: row.name,
        prompt: row.prompt,
        enabled: row.enabled !== false,
        lastRun: typeof row.lastRun === "string" ? row.lastRun : undefined,
        dailyAt: typeof dailyAt === "string" && TIME.test(dailyAt) ? dailyAt : undefined,
        interval: typeof interval === "string" && INTERVALS.has(interval) ? interval : undefined,
        rrule: typeof rrule === "string" && rrule.startsWith("FREQ=") ? rrule : undefined,
        recentRuns: readRecentRuns(row.recentRuns),
      },
    ]
  })
}

function readRecentRuns(recentRuns: unknown) {
  if (!Array.isArray(recentRuns)) return undefined
  const kept = recentRuns.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
    const row = entry as Record<string, unknown>
    if (typeof row.startedAt !== "string" || typeof row.endedAt !== "string") return []
    if (row.state !== "ok" && row.state !== "error") return []
    const summary: StoredRoutineRun = { startedAt: row.startedAt, endedAt: row.endedAt, state: row.state }
    if (typeof row.sessionID === "string") summary.sessionID = row.sessionID
    if (typeof row.error === "string") summary.error = row.error
    return [summary]
  })
  const tail = kept.slice(-10)
  return tail.length > 0 ? tail : undefined
}

export function routinesToConfig(routines: StoredRoutine[]) {
  return {
    routines: routines.map((routine) => ({
      id: routine.id,
      name: routine.name,
      prompt: routine.prompt,
      enabled: routine.enabled,
      lastRun: routine.lastRun,
      recentRuns: routine.recentRuns,
      schedule: routine.dailyAt
        ? { dailyAt: routine.dailyAt }
        : routine.interval
          ? { interval: routine.interval }
          : routine.rrule
            ? { rrule: routine.rrule }
            : undefined,
    })),
  }
}

export function routineId(name: string, taken: readonly string[]) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "routine"
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
}

export function addRoutine(
  routines: StoredRoutine[],
  input: { name: string; prompt: string; dailyAt?: string; interval?: string; rrule?: string },
) {
  return [
    ...routines,
    {
      id: routineId(input.name, routines.map((routine) => routine.id)),
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      enabled: true,
      dailyAt: input.rrule ? undefined : input.dailyAt,
      interval: input.rrule ? undefined : input.interval,
      rrule: input.rrule,
    },
  ]
}

export function toggleRoutine(routines: StoredRoutine[], id: string) {
  return routines.map((routine) => (routine.id === id ? { ...routine, enabled: !routine.enabled } : routine))
}

export function removeRoutine(routines: StoredRoutine[], id: string) {
  return routines.filter((routine) => routine.id !== id)
}
