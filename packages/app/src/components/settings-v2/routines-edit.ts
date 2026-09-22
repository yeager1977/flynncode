export type StoredRoutine = {
  id: string
  name: string
  prompt: string
  enabled: boolean
  lastRun?: string
  dailyAt?: string
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

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
    return [
      {
        id: row.id,
        name: row.name,
        prompt: row.prompt,
        enabled: row.enabled !== false,
        lastRun: typeof row.lastRun === "string" ? row.lastRun : undefined,
        dailyAt: typeof dailyAt === "string" && TIME.test(dailyAt) ? dailyAt : undefined,
      },
    ]
  })
}

export function routinesToConfig(routines: StoredRoutine[]) {
  return {
    routines: routines.map((routine) => ({
      id: routine.id,
      name: routine.name,
      prompt: routine.prompt,
      enabled: routine.enabled,
      lastRun: routine.lastRun,
      schedule: routine.dailyAt ? { dailyAt: routine.dailyAt } : undefined,
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

export function addRoutine(routines: StoredRoutine[], input: { name: string; prompt: string; dailyAt?: string }) {
  return [
    ...routines,
    {
      id: routineId(input.name, routines.map((routine) => routine.id)),
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      enabled: true,
      dailyAt: input.dailyAt,
    },
  ]
}

export function toggleRoutine(routines: StoredRoutine[], id: string) {
  return routines.map((routine) => (routine.id === id ? { ...routine, enabled: !routine.enabled } : routine))
}

export function removeRoutine(routines: StoredRoutine[], id: string) {
  return routines.filter((routine) => routine.id !== id)
}
