export type ActivityStatus = "running" | "needs-input" | "blocked" | "done" | "failed"

export type InboxKind = "dispatch" | "routine" | "session"

export function activityStatus(input: { type?: string; blocked?: boolean }): ActivityStatus {
  if (input.blocked) return "blocked"
  if (input.type === "busy" || input.type === "retry") return "running"
  if (input.type === "idle") return "needs-input"
  if (input.type === "error") return "failed"
  return "done"
}

export function inboxStatus(stored: ActivityStatus, live?: { type?: string; blocked?: boolean }) {
  if (!live) return stored
  if (live.type === "idle") return idleStatus(stored, live.blocked === true)
  return activityStatus(live)
}

// Live idle means the driver stopped after running. A task still stored as
// active has therefore finished; a stored failure is kept, and a blocked idle
// session still needs user input.
function idleStatus(stored: ActivityStatus, waiting: boolean): ActivityStatus {
  if (waiting) return "needs-input"
  if (stored === "failed") return "failed"
  return "done"
}

// Single status resolver for every inbox row. `kind` is reserved for future
// routine-specific mapping and does not change the result today.
export function inboxRowStatus(
  kind: InboxKind,
  stored: ActivityStatus,
  live?: { type?: string; blocked?: boolean },
  waiting = false,
): ActivityStatus {
  void kind
  if (!live) return stored
  if (live.type === "idle") return idleStatus(stored, waiting)
  return activityStatus(live)
}
