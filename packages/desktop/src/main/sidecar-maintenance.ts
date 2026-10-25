export const SIDECAR_START_STALL_TIMEOUT = 60_000
// DatabaseMaintenance.Progress from @flynncode/core, which desktop cannot import.
export type MaintenanceProgress = { phase: "compact"; state: "started" | "finished" }
export type MaintenanceMessage = { type: "maintenance" } & MaintenanceProgress
// The server converts a large history database once (a full VACUUM, minutes
// on a 13GB file). It blocks the sidecar thread, so no heartbeat can arrive
// until it finishes; allow it this long before treating startup as stalled.
export const SIDECAR_MAINTENANCE_TIMEOUT = 30 * 60_000

export function stallTimeoutFor(message: { type: string; phase?: string; state?: string }) {
  if (message.type === "maintenance" && message.phase === "compact" && message.state === "started")
    return SIDECAR_MAINTENANCE_TIMEOUT
  return SIDECAR_START_STALL_TIMEOUT
}
