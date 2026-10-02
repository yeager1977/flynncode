import type { Routine } from "./parse"

export function isDue(routine: Routine, now: Date) {
  if (!routine.enabled) return false
  if (!routine.dailyAt) return false
  const [hour, minute] = routine.dailyAt.split(":").map((part) => Number(part))
  const scheduled = hour * 60 + minute
  const current = now.getHours() * 60 + now.getMinutes()
  if (current < scheduled) return false
  if (!routine.lastRun) return true
  const last = new Date(routine.lastRun)
  if (Number.isNaN(last.getTime())) return true
  return last.getFullYear() !== now.getFullYear() || last.getMonth() !== now.getMonth() || last.getDate() !== now.getDate()
}

export function dueRoutines(routines: Routine[], now: Date) {
  return routines.filter((routine) => isDue(routine, now))
}
