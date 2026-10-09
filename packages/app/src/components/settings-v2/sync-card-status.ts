import type { MachineSyncPairResult, MachineSyncStatus } from "@/context/machine-sync-types"

export function syncHeadline(status: MachineSyncStatus) {
  if (!status.paired || status.peerName === null) return { key: "server.sync.unpaired" as const }
  if (status.paused) return { key: "server.sync.paused" as const, name: status.peerName }
  // Reachable but paused over there: not an outage, so not "offline".
  if (status.phase === "peer-paused") return { key: "server.sync.peerPaused" as const, name: status.peerName }
  return {
    key: status.online ? ("server.sync.online" as const) : ("server.sync.offline" as const),
    name: status.peerName,
  }
}

export function syncProblem(status: MachineSyncStatus) {
  if (status.phase === "mismatch") return { key: "server.sync.error.mismatch" as const }
  if (status.phase === "unauthorized") return { key: "server.sync.error.unauthorized" as const }
  if (status.failures.length > 0) return { key: "server.sync.error.failures" as const, count: status.failures.length }
  if (status.lastError) return { key: "server.sync.error.other" as const, error: status.lastError }
  return undefined
}

// Background cycles stay silent; only a manual Sync now that did not finish
// cleanly shows a toast.
export function syncNowFailed(status: MachineSyncStatus) {
  return status.phase !== "idle" || status.failures.length > 0 || status.lastError !== null
}

// Pairing succeeded either way; this only flags the one outcome the user
// should know about: they asked for the other computer's preferences and
// those could not be read.
export function syncPairNotice(result: MachineSyncPairResult) {
  if (result.ok && result.prefs === "unread") return "server.sync.prefs.unread" as const
  return undefined
}
