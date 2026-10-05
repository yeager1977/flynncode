export type DispatchStatus = "running" | "needs-input" | "blocked" | "done" | "failed"

export type DispatchTask = {
  sessionID: string
  title: string
  status: DispatchStatus
  directory: string
  unread: boolean
}

const LIMIT = 40

export function addDispatch(tasks: readonly DispatchTask[], task: DispatchTask) {
  return [task, ...tasks.filter((item) => item.sessionID !== task.sessionID)].slice(0, LIMIT)
}

export function completeDispatch(tasks: readonly DispatchTask[], sessionID: string) {
  return tasks.map((task) =>
    task.sessionID === sessionID
      ? { ...task, status: "done" as const, unread: task.unread || resolvedTransition(task.status, "done") }
      : task,
  )
}

export function failDispatch(tasks: readonly DispatchTask[], sessionID: string) {
  return tasks.map((task) =>
    task.sessionID === sessionID
      ? { ...task, status: "failed" as const, unread: task.unread || resolvedTransition(task.status, "failed") }
      : task,
  )
}

export function markDispatchRead(tasks: readonly DispatchTask[], sessionID: string) {
  return tasks.map((task) => (task.sessionID === sessionID ? { ...task, unread: false } : task))
}

export function reconcileDispatch(tasks: readonly DispatchTask[], active: ReadonlySet<string>) {
  let changed = false
  const next = tasks.map((task) => {
    if (task.status !== "running" || active.has(task.sessionID)) return task
    changed = true
    return { ...task, status: "done" as const, unread: task.unread || resolvedTransition(task.status, "done") }
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
    return [
      { sessionID: row.sessionID, title: row.title, status, directory: row.directory, unread: row.unread === true },
    ]
  }).slice(0, LIMIT)
}

export function resolvedTransition(prev: DispatchStatus, next: DispatchStatus) {
  const wasActive = prev === "running" || prev === "blocked" || prev === "needs-input"
  const isTerminal = next === "done" || next === "failed"
  return wasActive && isTerminal
}

function dispatchStatus(value: unknown): DispatchStatus | undefined {
  if (value === "running" || value === "needs-input" || value === "blocked" || value === "done" || value === "failed")
    return value
  return undefined
}

export function migrateDispatch(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { tasks: [] }
  return { tasks: parseDispatch((raw as { tasks?: unknown }).tasks) }
}
