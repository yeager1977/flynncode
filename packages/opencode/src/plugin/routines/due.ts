import { intervalMs, type Routine } from "./parse"

export function isDue(routine: Routine, now: Date) {
  if (!routine.enabled) return false
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
