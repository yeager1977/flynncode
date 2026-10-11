export type StoredRoutineRun = {
  sessionID?: string
  startedAt: string
  endedAt: string
  state: "ok" | "error"
  error?: string
}

export type StoredRoutineTarget = {
  url: string
  username?: string
  password?: string
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
  // Fields the schedule rows don't cover. createdAt/directory/trigger are
  // scheduler-owned and carried through untouched so saving here never drops
  // them. target IS edited (its own rows below) but a routine left untouched
  // keeps its target, including the stored password.
  createdAt?: string
  directory?: string
  target?: StoredRoutineTarget
  trigger?: Record<string, unknown>
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
        createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
        directory: typeof row.directory === "string" ? row.directory : undefined,
        target: readTarget(row.target),
        trigger: isRecord(row.trigger) ? row.trigger : undefined,
      },
    ]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

// Mirrors the backend readTarget shape: an object with a url and optional
// string credentials. Passwords are write-only in the UI, so the stored value
// is echoed into config but never rendered.
function readTarget(value: unknown): StoredRoutineTarget | undefined {
  if (!isRecord(value) || typeof value.url !== "string" || value.url.trim() === "") return undefined
  const target: StoredRoutineTarget = { url: value.url }
  if (typeof value.username === "string" && value.username !== "") target.username = value.username
  if (typeof value.password === "string" && value.password !== "") target.password = value.password
  return target
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
      createdAt: routine.createdAt,
      directory: routine.directory,
      target: routine.target,
      trigger: routine.trigger,
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

export type TargetInput = {
  targetUrl?: string
  targetUser?: string
  // Never prefilled from a stored routine; a blank value keeps the saved one or
  // leaves the target without credentials.
  targetPass?: string
}

export function routineTarget(input: TargetInput): StoredRoutineTarget | undefined {
  const url = (input.targetUrl ?? "").trim()
  if (!url) return undefined
    const target: StoredRoutineTarget = { url }
    const username = (input.targetUser ?? "").trim()
    if (username) target.username = username
    // The password row is write-only and kept verbatim: surrounding whitespace
    // may be significant.
    const password = input.targetPass ?? ""
    if (password) target.password = password
    return target
}

export function addRoutine(
  routines: StoredRoutine[],
  input: { name: string; prompt: string; dailyAt?: string; interval?: string; rrule?: string } & TargetInput,
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
      target: routineTarget(input),
    },
  ]
}

export function toggleRoutine(routines: StoredRoutine[], id: string) {
  return routines.map((routine) => (routine.id === id ? { ...routine, enabled: !routine.enabled } : routine))
}

export type RoutinePatch = Partial<Pick<StoredRoutine, "name" | "prompt" | "dailyAt" | "interval" | "rrule" | "directory">> &
  TargetInput

// Mirrors addRoutine's one-of precedence: rrule wins, then dailyAt, then
// interval. Schedule keys present with undefined values clear the schedule
// (manual); schedule keys absent leave it untouched. A targetInput with any
// present key edits the target; its url decides keep-vs-clear, while a blank
// password field keeps the stored password (the password row is write-only).
export function updateRoutine(routines: StoredRoutine[], id: string, patch: RoutinePatch) {
  if (patch.rrule !== undefined && !isValidRrule(patch.rrule)) throw new Error(`Invalid rrule: ${patch.rrule}`)
  const schedule = patch.rrule !== undefined
    ? { rrule: patch.rrule }
    : patch.dailyAt !== undefined
      ? { dailyAt: patch.dailyAt }
      : patch.interval !== undefined
        ? { interval: patch.interval }
        : undefined
  const editsSchedule = "rrule" in patch || "dailyAt" in patch || "interval" in patch
  const editsTarget = "targetUrl" in patch || "targetUser" in patch || "targetPass" in patch
  return routines.map((routine) => {
    if (routine.id !== id) return routine
    return {
      ...routine,
      name: patch.name ?? routine.name,
      prompt: patch.prompt ?? routine.prompt,
      directory: patch.directory ?? routine.directory,
      dailyAt: schedule?.dailyAt ?? (editsSchedule ? undefined : routine.dailyAt),
      interval: schedule?.interval ?? (editsSchedule ? undefined : routine.interval),
      rrule: schedule?.rrule ?? (editsSchedule ? undefined : routine.rrule),
      target: editsTarget
        ? mergeTarget(
            routine,
            routineTarget({ targetUrl: patch.targetUrl, targetUser: patch.targetUser, targetPass: patch.targetPass }),
          )
        : routine.target,
    }
  })
}

// When the edited (or new) target has no url, the target is cleared; otherwise
// an edit that leaves the password row blank keeps the stored password — but
// only for the same host. A changed url drops stored credentials so the old
// host's password is never attached to the new one.
function mergeTarget(routine: StoredRoutine, next: StoredRoutineTarget | undefined) {
  if (!next) return undefined
  if (!next.password) {
    const stored = routine.target?.url === next.url ? routine.target?.password : undefined
    if (stored) return { ...next, password: stored }
  }
  return next
}

export function removeRoutine(routines: StoredRoutine[], id: string) {
  return routines.filter((routine) => routine.id !== id)
}
