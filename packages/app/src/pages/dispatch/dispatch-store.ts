export type DispatchStatus = "running" | "done" | "failed"

export type DispatchTask = {
  sessionID: string
  title: string
  status: DispatchStatus
  directory: string
}

const LIMIT = 40

export function addDispatch(tasks: readonly DispatchTask[], task: DispatchTask) {
  return [task, ...tasks.filter((item) => item.sessionID !== task.sessionID)].slice(0, LIMIT)
}

export function completeDispatch(tasks: readonly DispatchTask[], sessionID: string) {
  return tasks.map((task) => (task.sessionID === sessionID ? { ...task, status: "done" as const } : task))
}

export function failDispatch(tasks: readonly DispatchTask[], sessionID: string) {
  return tasks.map((task) => (task.sessionID === sessionID ? { ...task, status: "failed" as const } : task))
}

export function reconcileDispatch(tasks: readonly DispatchTask[], active: ReadonlySet<string>) {
  let changed = false
  const next = tasks.map((task) => {
    if (task.status !== "running" || active.has(task.sessionID)) return task
    changed = true
    return { ...task, status: "done" as const }
  })
  return changed ? next : tasks
}

export function parseDispatch(raw: unknown): DispatchTask[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const status = dispatchStatus(row.status)
    if (!status || typeof row.sessionID !== "string" || typeof row.title !== "string" || typeof row.directory !== "string")
      return []
    return [{ sessionID: row.sessionID, title: row.title, status, directory: row.directory }]
  }).slice(0, LIMIT)
}

function dispatchStatus(value: unknown): DispatchStatus | undefined {
  if (value === "running" || value === "done" || value === "failed") return value
  return undefined
}

export function migrateDispatch(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { tasks: [] }
  return { tasks: parseDispatch((raw as { tasks?: unknown }).tasks) }
}
