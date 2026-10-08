import { RRule } from "rrule"
import { intervalMs, type Routine } from "./parse"

export function isDue(routine: Routine, now: Date) {
  if (!routine.enabled) return false
  if (routine.rrule) return isRruleDue(routine, now)
  if (routine.interval) return isIntervalDue(routine, now)
  if (!routine.dailyAt) return false
  const [hour, minute] = routine.dailyAt.split(":").map((part) => Number(part))
  const scheduled = hour * 60 + minute
  const current = now.getHours() * 60 + now.getMinutes()
  if (!routine.lastRun) {
    if (current < scheduled) return false
    return true
  }
  const last = new Date(routine.lastRun)
  if (Number.isNaN(last.getTime())) return true
  const ranToday = last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate()
  if (ranToday) return false
  if (current >= scheduled) return true
  // Startup-elapsed recovery: now is before today's scheduled minute, but the
  // previous occurrence (yesterday's local day) has no recorded run, so fire
  // once instead of waiting another 24h.
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const ranYesterday = last.getFullYear() === yesterday.getFullYear() && last.getMonth() === yesterday.getMonth() && last.getDate() === yesterday.getDate()
  return !ranYesterday
}

function rruleOptions(routine: Routine, now: Date) {
  const text = routine.rrule ?? ""
  try {
    const options = RRule.parseString(text)
    // rrule evaluates in UTC. Run it on "floating" wall-clock-as-UTC dates so
    // BYHOUR/BYDAY mean local time. A DTSTART/UNTIL with a trailing Z is a real
    // UTC instant; without it the value already is floating wall-clock time.
    // Without DTSTART, anchor at the routine's creation so COUNT and INTERVAL
    // count from when it was saved.
    return new RRule({
      ...options,
      tzid: null,
      dtstart: options.dtstart
        ? /DTSTART[^:\n]*:\d{8}T\d{6}Z/i.test(text)
          ? toFloating(options.dtstart)
          : options.dtstart
        : toFloating(anchor(routine, now)),
      until: options.until && /UNTIL=\d{8}T\d{6}Z/i.test(text) ? toFloating(options.until) : options.until,
    })
  } catch {
    return undefined
  }
}

function isRruleDue(routine: Routine, now: Date) {
  const rule = rruleOptions(routine, now)
  if (!rule) return false
  const last = routine.lastRun ? new Date(routine.lastRun) : undefined
  if (last && Number.isNaN(last.getTime())) return true
  // Never-run routines look for the first occurrence since creation (or local
  // midnight for routines saved before createdAt existed), so they do not
  // fire for every occurrence that predates them.
  const next = rule.after(toFloating(last ?? anchor(routine, now)), true)
  if (!next) return false
  return fromFloating(next).getTime() <= now.getTime()
}

export function nextOccurrence(routine: Routine, now: Date) {
  const next = rruleOptions(routine, now)?.after(toFloating(now), false)
  return next ? fromFloating(next) : undefined
}

function anchor(routine: Routine, now: Date) {
  if (routine.createdAt) return new Date(routine.createdAt)
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function toFloating(date: Date) {
  return new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
      date.getMilliseconds(),
    ),
  )
}

function fromFloating(date: Date) {
  return new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  )
}

function isIntervalDue(routine: Routine, now: Date) {
  const gap = intervalMs(routine.interval!)
  if (gap === undefined) return false
  if (!routine.lastRun) return true
  const last = new Date(routine.lastRun)
  if (Number.isNaN(last.getTime())) return true
  return now.getTime() >= last.getTime() + gap
}

export function dueRoutines(routines: Routine[], now: Date) {
  return routines.filter((routine) => isDue(routine, now))
}
