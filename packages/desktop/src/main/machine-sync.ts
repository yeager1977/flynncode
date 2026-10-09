import { randomInt, randomUUID } from "node:crypto"
import type { SyncStatus } from "@flynncode/mobile-gateway/sync"
import { PAIRING_CODE_TTL_MS, type SyncPrefs } from "@flynncode/mobile-gateway/sync-gate"
import { pairWithPeer, unpairPeer } from "@flynncode/mobile-gateway/sync-pair"
import type {
  MachineSyncPairingCode,
  MachineSyncPairResult,
  MachineSyncStatus,
} from "@opencode-ai/app/machine-sync-types"
import {
  parsePeer,
  parsePrefs,
  type SidecarSyncCommand,
  type SidecarSyncMessage,
  type SidecarSyncStart,
} from "./sidecar-sync"
import { PHONE_ACCESS_KEY, SYNC_PAUSED_KEY, SYNC_PEER_KEY, SYNC_PREFS_KEY } from "./store-keys"

const SYNC_NOW_TIMEOUT_MS = 120_000

export type SyncStore = {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
}

export type MachineSync = ReturnType<typeof createMachineSync>

export function readSyncStart(store: SyncStore, machineName: string): SidecarSyncStart {
  return {
    machineName,
    phoneAccess: store.get(PHONE_ACCESS_KEY) === true,
    paused: store.get(SYNC_PAUSED_KEY) === true,
    peer: parsePeer(store.get(SYNC_PEER_KEY)) ?? null,
    prefs: parsePrefs(store.get(SYNC_PREFS_KEY)) ?? null,
  }
}

// Renderer input is untrusted: accept a bare host, host:port or an http(s)
// origin (no path, query or credentials) and exactly six code digits.
export function parsePairInput(host: unknown, code: unknown) {
  if (typeof host !== "string" || typeof code !== "string") return
  const trimmedHost = host.trim()
  const trimmedCode = code.trim()
  if (!/^(https?:\/\/)?[A-Za-z0-9.\-[\]:]{1,253}$/.test(trimmedHost)) return
  if (!/^\d{6}$/.test(trimmedCode)) return
  return { host: unbracket(trimmedHost), code: trimmedCode }
}

// pairWithPeer adds the brackets itself for a bare IPv6 address, so `[::1]`
// becomes `::1`; `[::1]:4097` becomes a URL, which it takes as given.
function unbracket(host: string) {
  const bare = /^\[([0-9A-Fa-f:]+)\]$/.exec(host)
  if (bare) return bare[1]
  return /^\[[0-9A-Fa-f:]+\]:\d+$/.test(host) ? `http://${host}` : host
}

// Main owns the persisted sync settings; the sidecar owns the live gate and
// worker. Every change is written here first and then pushed to the sidecar,
// so a restart always starts from the stored state.
export function createMachineSync(deps: {
  store: SyncStore
  machineName: string
  post: (command: SidecarSyncCommand) => void
  broadcast: (channel: "machine-sync-status" | "machine-sync-peer-prefs", payload: unknown) => void
  lanAddresses: () => string[]
  fetchImpl?: typeof fetch
  now?: () => number
  code?: () => string
}) {
  const now = deps.now ?? Date.now
  const pending = new Map<string, () => void>()
  const state = { worker: undefined as SyncStatus | undefined, gatewayError: null as string | null }

  const settings = () => readSyncStart(deps.store, deps.machineName)

  const pushConfig = () => {
    const current = settings()
    deps.post({ type: "sync-config", phoneAccess: current.phoneAccess, paused: current.paused, peer: current.peer })
  }

  const status = (): MachineSyncStatus => {
    const current = settings()
    // A status that lands after unpair must not leak into the unpaired view.
    const worker = current.peer === null ? undefined : state.worker
    return {
      paired: current.peer !== null,
      peerName: current.peer?.name ?? null,
      paused: current.paused,
      phase: current.peer === null ? "unpaired" : current.paused ? "paused" : (worker?.phase ?? "idle"),
      online: current.peer !== null && (worker?.online ?? false),
      lastSuccess: worker?.lastSuccess ?? null,
      received: worker?.received ?? 0,
      sent: worker?.sent ?? 0,
      missingDirectories: worker?.missingDirectories ?? [],
      backlog: worker?.backlog ?? null,
      failures: worker?.failures ?? [],
      lastError: worker?.lastError ?? null,
      gatewayError: state.gatewayError,
      machineName: deps.machineName,
      addresses: deps.lanAddresses(),
    }
  }

  const publish = () => deps.broadcast("machine-sync-status", status())

  return {
    status,
    phoneAccess: () => settings().phoneAccess,
    setPhoneAccess(enabled: boolean) {
      deps.store.set(PHONE_ACCESS_KEY, enabled)
      pushConfig()
    },
    setPaused(paused: boolean) {
      deps.store.set(SYNC_PAUSED_KEY, paused)
      pushConfig()
      publish()
    },
    createPairingCode(): MachineSyncPairingCode {
      const code = deps.code?.() ?? String(randomInt(0, 1_000_000)).padStart(6, "0")
      const expiresAt = now() + PAIRING_CODE_TTL_MS
      deps.post({ type: "sync-pairing-code", code, expiresAt })
      return { code, expiresAt, machineName: deps.machineName, addresses: deps.lanAddresses() }
    },
    async pair(input: { host: string; code: string }): Promise<MachineSyncPairResult> {
      const result = await pairWithPeer({
        host: input.host,
        code: input.code,
        name: deps.machineName,
        fetchImpl: deps.fetchImpl,
      })
      if (!result.ok) return { ok: false, reason: result.reason }
      const previous = settings().peer
      state.worker = undefined
      deps.store.set(SYNC_PEER_KEY, result.peer)
      pushConfig()
      publish()
      // Re-pairing replaces the peer; tell the old one so its token stops working.
      if (previous && previous.token !== result.peer.token) await unpairPeer({ peer: previous, fetchImpl: deps.fetchImpl })
      return { ok: true }
    },
    async unpair() {
      const peer = settings().peer
      state.worker = undefined
      deps.store.delete(SYNC_PEER_KEY)
      pushConfig()
      publish()
      if (peer) await unpairPeer({ peer, fetchImpl: deps.fetchImpl })
    },
    syncNow() {
      const requestID = randomUUID()
      return new Promise<MachineSyncStatus>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestID)
          resolve(status())
        }, SYNC_NOW_TIMEOUT_MS)
        timer.unref()
        pending.set(requestID, () => {
          clearTimeout(timer)
          resolve(status())
        })
        deps.post({ type: "sync-now", requestID })
      })
    },
    pushPrefs(prefs: SyncPrefs): SyncPrefs | undefined {
      const stored = parsePrefs(deps.store.get(SYNC_PREFS_KEY))
      if (stored && stored.updatedAt > prefs.updatedAt) return stored
      deps.store.set(SYNC_PREFS_KEY, prefs)
      deps.post({ type: "sync-prefs", prefs })
      return undefined
    },
    handleSidecarMessage(message: SidecarSyncMessage) {
      if (message.type === "sync-paired") {
        state.worker = undefined
        deps.store.set(SYNC_PEER_KEY, message.peer)
        publish()
        return
      }
      if (message.type === "sync-unpaired") {
        state.worker = undefined
        deps.store.delete(SYNC_PEER_KEY)
        publish()
        return
      }
      if (message.type === "sync-peer-prefs") {
        deps.store.set(SYNC_PREFS_KEY, message.prefs)
        deps.broadcast("machine-sync-peer-prefs", message.prefs)
        return
      }
      if (message.type === "sync-gateway") {
        state.gatewayError = message.error
        publish()
        return
      }
      state.worker = message.status
      const waiting = message.requestID === undefined ? undefined : pending.get(message.requestID)
      if (message.requestID !== undefined) pending.delete(message.requestID)
      waiting?.()
      publish()
    },
  }
}
