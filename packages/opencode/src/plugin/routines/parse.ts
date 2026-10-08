import { RRule } from "rrule"

export type Routine = {
  id: string
  name: string
  prompt: string
  enabled: boolean
  dailyAt?: string
  interval?: string
  rrule?: string
  lastRun?: string
}

export type RoutinesFile = {
  routines: Routine[]
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export const INTERVALS = ["15m", "1h", "6h", "1d", "1w"] as const

export type Interval = (typeof INTERVALS)[number]

const INTERVAL_MS: Record<Interval, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
}

export function intervalMs(interval: string) {
  return INTERVAL_MS[interval as Interval]
}

export function parseRoutines(raw: unknown): { ok: true; value: RoutinesFile } | { ok: false; errors: string[] } {
  const items = routineItems(raw)
  if (!items.ok) return items
  const errors: string[] = []
  const routines = items.value.flatMap((item, index) => {
    const parsed = parseRoutine(item, index, errors)
    return parsed ? [parsed] : []
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { routines } }
}

function routineItems(raw: unknown): { ok: true; value: unknown[] } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (Array.isArray(raw)) return { ok: true, value: raw }
  if (typeof raw !== "object") return { ok: false, errors: ["routines file must be an object"] }
  const routines = (raw as Record<string, unknown>).routines
  if (routines === undefined) return { ok: true, value: [] }
  if (!Array.isArray(routines)) return { ok: false, errors: ["routines must be an array"] }
  return { ok: true, value: routines }
}

function parseRoutine(item: unknown, index: number, errors: string[]) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    errors.push(`routines.${index} must be an object`)
    return
  }
  const row = item as Record<string, unknown>
  if (typeof row.id !== "string" || row.id.trim() === "") errors.push(`routines.${index}.id must be a string`)
  if (typeof row.name !== "string" || row.name.trim() === "") errors.push(`routines.${index}.name must be a string`)
  if (typeof row.prompt !== "string" || row.prompt.trim() === "") errors.push(`routines.${index}.prompt must be a string`)
  const schedule = readSchedule(row.schedule, index, errors)
  if (errors.some((error) => error.startsWith(`routines.${index}`))) return
  if (!schedule) return
  return {
    id: row.id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    enabled: typeof row.enabled === "boolean" ? row.enabled : true,
    dailyAt: schedule.dailyAt,
    interval: schedule.interval,
    rrule: schedule.rrule,
    lastRun: typeof row.lastRun === "string" ? row.lastRun : undefined,
  }
}

function readSchedule(schedule: unknown, index: number, errors: string[]) {
  if (schedule === undefined || schedule === "manual") return {}
  if (typeof schedule === "string") {
    errors.push(`routines.${index}.schedule must be "manual", { dailyAt }, or { interval }`)
    return
  }
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    errors.push(`routines.${index}.schedule must be an object`)
    return
  }
  const row = schedule as Record<string, unknown>
  const dailyAt = readDailyAt(row.dailyAt, index, errors)
  const interval = readInterval(row.interval, index, errors)
  const rrule = readRrule(row.rrule, index, errors)
  const set = [dailyAt, interval, rrule].filter((entry) => entry !== undefined)
  if (set.length > 1) {
    errors.push(`routines.${index}.schedule must set only one of dailyAt, interval, rrule`)
    return
  }
  return { dailyAt, interval, rrule }
}

function readDailyAt(dailyAt: unknown, index: number, errors: string[]) {
  if (dailyAt === undefined) return undefined
  if (typeof dailyAt !== "string" || !TIME.test(dailyAt)) {
    errors.push(`routines.${index}.schedule.dailyAt must be HH:MM`)
    return undefined
  }
  return dailyAt
}

function readInterval(interval: unknown, index: number, errors: string[]) {
  if (interval === undefined) return undefined
  if (typeof interval !== "string" || !(INTERVALS as readonly string[]).includes(interval)) {
    errors.push(`routines.${index}.schedule.interval must be one of ${INTERVALS.join("|")}`)
    return undefined
  }
  return interval
}

function readRrule(rrule: unknown, index: number, errors: string[]) {
  if (rrule === undefined) return undefined
  if (typeof rrule !== "string" || rrule.trim() === "") {
    errors.push(`routines.${index}.schedule.rrule must be an RRULE string like FREQ=WEEKLY;BYDAY=MO`)
    return undefined
  }
  try {
    RRule.fromString(rrule)
  } catch {
    errors.push(`routines.${index}.schedule.rrule must be a valid RRULE string`)
    return undefined
  }
  return rrule
}
