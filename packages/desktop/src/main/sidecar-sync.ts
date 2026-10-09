import type { SyncStatus } from "@flynncode/mobile-gateway/sync"
import type { SyncPeer, SyncPrefs } from "@flynncode/mobile-gateway/sync-gate"

export type SidecarSyncStart = {
  machineName: string
  phoneAccess: boolean
  paused: boolean
  peer: SyncPeer | null
  prefs: SyncPrefs | null
}

export type SidecarSyncCommand =
  | { type: "sync-config"; phoneAccess: boolean; paused: boolean; peer: SyncPeer | null }
  | { type: "sync-pairing-code"; code: string; expiresAt: number }
  | { type: "sync-now"; requestID: string }
  | { type: "sync-reload"; requestID: string }
  | { type: "sync-prefs"; prefs: SyncPrefs }

export type SidecarSyncMessage =
  | { type: "sync-paired"; peer: SyncPeer }
  // The paired machine now answers at a new address (same token).
  | { type: "sync-peer-moved"; peer: SyncPeer }
  | { type: "sync-unpaired" }
  | { type: "sync-status"; status: SyncStatus; requestID?: string }
  | { type: "sync-peer-prefs"; prefs: SyncPrefs }
  // Set while the LAN gateway is wanted but could not start (e.g. port busy).
  | { type: "sync-gateway"; error: string | null }

export function parsePeer(value: unknown): SyncPeer | undefined {
  if (!isRecord(value)) return
  if (typeof value.name !== "string" || typeof value.url !== "string" || typeof value.token !== "string") return
  if (!value.token) return
  return { name: value.name, url: value.url, token: value.token }
}

export function parsePrefs(value: unknown): SyncPrefs | undefined {
  if (!isRecord(value) || !isRecord(value.sections) || typeof value.updatedAt !== "number") return
  return { sections: value.sections, updatedAt: value.updatedAt }
}

export function parseSyncStart(value: unknown): SidecarSyncStart | undefined {
  if (!isRecord(value) || typeof value.machineName !== "string") return
  if (typeof value.phoneAccess !== "boolean" || typeof value.paused !== "boolean") return
  const peer = value.peer === null ? null : parsePeer(value.peer)
  const prefs = value.prefs === null ? null : parsePrefs(value.prefs)
  if (peer === undefined || prefs === undefined) return
  return { machineName: value.machineName, phoneAccess: value.phoneAccess, paused: value.paused, peer, prefs }
}

export function parseSyncCommand(value: unknown): SidecarSyncCommand | undefined {
  if (!isRecord(value)) return
  if (value.type === "sync-config") {
    if (typeof value.phoneAccess !== "boolean" || typeof value.paused !== "boolean") return
    const peer = value.peer === null ? null : parsePeer(value.peer)
    if (peer === undefined) return
    return { type: "sync-config", phoneAccess: value.phoneAccess, paused: value.paused, peer }
  }
  if (value.type === "sync-pairing-code") {
    if (typeof value.code !== "string" || typeof value.expiresAt !== "number") return
    return { type: "sync-pairing-code", code: value.code, expiresAt: value.expiresAt }
  }
  if (value.type === "sync-now" || value.type === "sync-reload") {
    if (typeof value.requestID !== "string") return
    return { type: value.type, requestID: value.requestID }
  }
  if (value.type === "sync-prefs") {
    const prefs = parsePrefs(value.prefs)
    if (!prefs) return
    return { type: "sync-prefs", prefs }
  }
  return
}

export function isSyncMessage(value: unknown): value is SidecarSyncMessage {
  if (!isRecord(value)) return false
  if (value.type === "sync-paired" || value.type === "sync-peer-moved") return parsePeer(value.peer) !== undefined
  if (value.type === "sync-unpaired") return true
  if (value.type === "sync-status") return isRecord(value.status)
  if (value.type === "sync-peer-prefs") return parsePrefs(value.prefs) !== undefined
  if (value.type === "sync-gateway") return value.error === null || typeof value.error === "string"
  return false
}

// The LAN gateway only listens while something needs it: phone access, a
// paired peer, or a pairing code waiting to be used.
export function gatewayWanted(input: { phoneAccess: boolean; peer: SyncPeer | undefined; pairingActive: boolean }) {
  return input.phoneAccess || input.peer !== undefined || input.pairingActive
}

// Runs every shutdown step in order. A failing step (thrown or rejected) is
// reported and never skips the steps after it, so disposing instances and
// closing the listener always happen.
export async function shutdown(
  steps: Array<{ name: string; run: () => unknown }>,
  onError: (name: string, error: unknown) => void,
) {
  await steps.reduce(
    (previous, step) =>
      previous.then(() =>
        Promise.resolve()
          .then(step.run)
          .then(
            () => undefined,
            (error: unknown) => onError(step.name, error),
          ),
      ),
    Promise.resolve(),
  )
}

// Runs apply one call at a time. A failing apply is reported and swallowed so
// the returned promise never rejects: callers can await or void it safely.
export function createReconciler(apply: () => Promise<void>, onError: (error: unknown) => void) {
  let queue: Promise<void> = Promise.resolve()
  return () => {
    queue = queue.then(apply).catch((error) => {
      onError(error)
    })
    return queue
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
