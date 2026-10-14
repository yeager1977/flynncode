// Dispatch tasks persist one of these; inbox rows can additionally show that a
// session stopped on a provider usage limit.
export type TaskStatus = "running" | "needs-input" | "blocked" | "done" | "failed"
export type ActivityStatus = TaskStatus | "usage-limit"

export type InboxKind = "dispatch" | "routine" | "session"

export function activityStatus(input: { type?: string; blocked?: boolean }): TaskStatus {
  if (input.blocked) return "blocked"
  if (input.type === "busy" || input.type === "retry") return "running"
  if (input.type === "idle") return "needs-input"
  if (input.type === "error") return "failed"
  return "done"
}

// `limited` means the session's newest turn ended on a usage limit. Dispatch
// tasks persist only TaskStatus, so a stopped-on-limit task is recorded as
// failed rather than done. A missing live entry counts as idle for this check.
export function inboxStatus(stored: TaskStatus, live?: { type?: string; blocked?: boolean }, limited = false) {
  if (!live) return limited ? "failed" : stored
  if (live.type === "idle") {
    if (limited && live.blocked !== true) return "failed"
    return idleStatus(stored, live.blocked === true)
  }
  return activityStatus(live)
}

// Live idle means the driver stopped after running. A task still stored as
// active has therefore finished; a stored failure is kept, and a blocked idle
// session still needs user input.
function idleStatus(stored: ActivityStatus, waiting: boolean): TaskStatus {
  if (waiting) return "needs-input"
  if (stored === "failed") return "failed"
  return "done"
}

// Single status resolver for every inbox row. `kind` is reserved for future
// routine-specific mapping and does not change the result today. `limited`
// means the session's newest turn ended on a usage limit: sessions stop (go
// idle) on a limit, so an idle, non-waiting limited session reads as limited.
export function inboxRowStatus(
  kind: InboxKind,
  stored: ActivityStatus,
  live?: { type?: string; blocked?: boolean },
  waiting = false,
  limited = false,
): ActivityStatus {
  void kind
  if (!live) return limited && !waiting ? "usage-limit" : stored
  if (live.type === "idle" && limited && !waiting) return "usage-limit"
  if (live.type === "idle") return idleStatus(stored, waiting)
  return activityStatus(live)
}
