export type Routine = {
  id: string
  name: string
  prompt: string
  enabled: boolean
  dailyAt?: string
  lastRun?: string
}

export type RoutinesFile = {
  routines: Routine[]
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function parseRoutines(raw: unknown): { ok: true; value: RoutinesFile } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, value: { routines: [] } }
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["routines file must be an object"] }
  const body = raw as Record<string, unknown>
  if (body.routines === undefined) return { ok: true, value: { routines: [] } }
  if (!Array.isArray(body.routines)) return { ok: false, errors: ["routines must be an array"] }
  const errors: string[] = []
  const routines = body.routines.flatMap((item, index) => {
    const parsed = parseRoutine(item, index, errors)
    return parsed ? [parsed] : []
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { routines } }
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
  const dailyAt = readDailyAt(row.schedule, index, errors)
  if (errors.some((error) => error.startsWith(`routines.${index}`))) return
  return {
    id: row.id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    enabled: typeof row.enabled === "boolean" ? row.enabled : true,
    dailyAt,
    lastRun: typeof row.lastRun === "string" ? row.lastRun : undefined,
  }
}

function readDailyAt(schedule: unknown, index: number, errors: string[]) {
  if (schedule === undefined) return undefined
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    errors.push(`routines.${index}.schedule must be an object`)
    return
  }
  const dailyAt = (schedule as Record<string, unknown>).dailyAt
  if (dailyAt === undefined) return undefined
  if (typeof dailyAt !== "string" || !TIME.test(dailyAt)) {
    errors.push(`routines.${index}.schedule.dailyAt must be HH:MM`)
    return
  }
  return dailyAt
}
