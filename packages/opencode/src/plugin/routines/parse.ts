import path from "path"
import { RRule } from "rrule"

export type RoutineRunSummary = {
  sessionID?: string
  startedAt: string
  endedAt: string
  state: "ok" | "error"
  error?: string
}

export type TriggerGithub = {
  owner: string
  repo: string
  event: "pr" | "issue"
}

export type RoutineTrigger = {
  files?: string[]
  github?: TriggerGithub
}

export type Routine = {
  id: string
  name: string
  prompt: string
  enabled: boolean
  dailyAt?: string
  interval?: string
  rrule?: string
  lastRun?: string
  // First time the routine was saved or seen by the scheduler; anchors RRULEs
  // without an explicit DTSTART so COUNT/INTERVAL rules count from creation.
  createdAt?: string
  // Absolute (or ~/-relative) directory routine sessions run in and file
  // triggers watch. Without it sessions run in the home directory and file
  // triggers are skipped.
  directory?: string
  recentRuns?: RoutineRunSummary[]
  trigger?: RoutineTrigger
  // Where the routine's sessions run: the local server ("local", omitted) or a
  // remote OpenCode host reached over HTTP.
  target?: "local" | RoutineTarget
}

export type RoutineTarget = {
  url: string
  username?: string
  password?: string
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
  const recentRuns = readRecentRuns(row.recentRuns)
  const trigger = readTrigger(row.trigger, index, errors)
  const target = readTarget(row.target, index, errors)
  const directory = readDirectory(row.directory, index, errors)
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
    createdAt: typeof row.createdAt === "string" && !Number.isNaN(Date.parse(row.createdAt)) ? row.createdAt : undefined,
    directory,
    recentRuns,
    trigger,
    target,
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

function readTarget(target: unknown, index: number, errors: string[]) {
  if (target === undefined) return undefined
  if (target === "local") return "local" as const
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    errors.push(`routines.${index}.target must be "local" or an object with a url`)
    return undefined
  }
  const row = target as Record<string, unknown>
  const url = readTargetUrl(row.url, index, errors)
  // Credentials are user-authored in the local routine config and are only ever
  // sent to the target server as a basic auth header; never log or echo them.
  const username = readTargetValue(row.username, index, "username", errors)
  const password = readTargetValue(row.password, index, "password", errors)
  if (errors.some((error) => error.startsWith(`routines.${index}.target`))) return undefined
  if (!url) return undefined
  const out: RoutineTarget = { url }
  if (username) out.username = username
  if (password) out.password = password
  return out
}

function readTargetUrl(url: unknown, index: number, errors: string[]) {
  if (typeof url !== "string" || url.trim() === "") {
    errors.push(`routines.${index}.target.url must be an http(s) URL like http://host:4096`)
    return undefined
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http(s)")
  } catch {
    errors.push(`routines.${index}.target.url must be an http(s) URL like http://host:4096`)
    return undefined
  }
  return url
}

function readTargetValue(value: unknown, index: number, field: string, errors: string[]) {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`routines.${index}.target.${field} must be a string`)
    return undefined
  }
  return value
}

function readDirectory(directory: unknown, index: number, errors: string[]) {
  if (directory === undefined) return undefined
  if (typeof directory !== "string" || !(path.isAbsolute(directory) || directory.startsWith("~/"))) {
    errors.push(`routines.${index}.directory must be an absolute path`)
    return undefined
  }
  return directory
}

function readTrigger(trigger: unknown, index: number, errors: string[]) {
  if (trigger === undefined) return undefined
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
    errors.push(`routines.${index}.trigger must be an object`)
    return undefined
  }
  const row = trigger as Record<string, unknown>
  const files = readTriggerFiles(row.files, index, errors)
  const github = readTriggerGithub(row.github, index, errors)
  if (errors.some((error) => error.startsWith(`routines.${index}.trigger`))) return undefined
  if (!files && !github) {
    errors.push(`routines.${index}.trigger must set files or github`)
    return undefined
  }
  const out: RoutineTrigger = {}
  if (files) out.files = files
  if (github) out.github = github
  return out
}

function readTriggerFiles(files: unknown, index: number, errors: string[]) {
  if (files === undefined) return undefined
  if (!Array.isArray(files) || files.length === 0 || files.length > 10) {
    errors.push(`routines.${index}.trigger.files must be an array of 1-10 glob patterns`)
    return undefined
  }
  for (const pattern of files) {
    if (typeof pattern !== "string" || pattern.trim() === "" || pattern.startsWith("/") || pattern.split("/").includes("..")) {
      errors.push(`routines.${index}.trigger.files must be relative globs without .. segments`)
      return undefined
    }
  }
  return files as string[]
}

function readTriggerGithub(github: unknown, index: number, errors: string[]) {
  if (github === undefined) return undefined
  if (!github || typeof github !== "object" || Array.isArray(github)) {
    errors.push(`routines.${index}.trigger.github must be an object`)
    return undefined
  }
  const row = github as Record<string, unknown>
  if (
    typeof row.owner !== "string" ||
    row.owner.trim() === "" ||
    typeof row.repo !== "string" ||
    row.repo.trim() === "" ||
    (row.event !== "pr" && row.event !== "issue")
  ) {
    errors.push(`routines.${index}.trigger.github must set owner, repo, and event ("pr" or "issue")`)
    return undefined
  }
  return { owner: row.owner, repo: row.repo, event: row.event as "pr" | "issue" }
}

function readRecentRuns(recentRuns: unknown) {
  if (!Array.isArray(recentRuns)) return undefined
  const kept = recentRuns.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
    const row = entry as Record<string, unknown>
    if (typeof row.startedAt !== "string" || typeof row.endedAt !== "string") return []
    if (row.state !== "ok" && row.state !== "error") return []
    const summary: RoutineRunSummary = {
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      state: row.state,
    }
    if (typeof row.sessionID === "string") summary.sessionID = row.sessionID
    if (typeof row.error === "string") summary.error = row.error
    return [summary]
  })
  const tail = kept.slice(-10)
  return tail.length > 0 ? tail : undefined
}
