export type ActivityStatus = "running" | "needs-input" | "blocked" | "done" | "failed"

export function activityStatus(input: { type?: string; blocked?: boolean }): ActivityStatus {
  if (input.blocked) return "blocked"
  if (input.type === "busy" || input.type === "retry") return "running"
  if (input.type === "idle") return "needs-input"
  if (input.type === "error") return "failed"
  return "done"
}

export function inboxStatus(stored: ActivityStatus, live?: { type?: string; blocked?: boolean }) {
  if (!live) return stored
  // Live idle only means the driver is not running, so a finished dispatch
  // keeps its stored terminal status; blocked idle still needs user input.
  if (live.type === "idle") return live.blocked ? "needs-input" : stored
  return activityStatus(live)
}
