import { randomInt, randomUUID } from "node:crypto"
import type { SyncStatus } from "@flynncode/mobile-gateway/sync"
import { PAIRING_CODE_TTL_MS, type SyncPrefs } from "@flynncode/mobile-gateway/sync-gate"
import { pairWithPeer, unpairPeer } from "@flynncode/mobile-gateway/sync-pair"
import { signedRequest } from "@flynncode/mobile-gateway/sync-sign"
import type {
  MachineSyncPairingCode,
  MachineSyncPairResult,
  MachineSyncPrefsChoice,
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
const SIDECAR_DOWN = "the local server is not running"
// pair() waits for this when the user chose the other computer's prefs.
const PEER_PREFS_TIMEOUT_MS = 5_000

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

// Resolves to `{ prefs: null }` when the peer answered but has no prefs, and
// to undefined when it could not be asked (unreachable, timeout, non-OK or an
// unreadable body): those must not be mistaken for each other.
async function fetchPeerPrefs(peer: { url: string; token: string }, fetchImpl: typeof fetch = fetch) {
  // Signed like every request after pairing; an unsigned or altered answer is
  // treated as unreadable.
  const reply = await signedRequest({
    peer,
    path: "/flynncode-sync/prefs",
    timeoutMs: PEER_PREFS_TIMEOUT_MS,
    fetchImpl,
  })
  if (!reply || reply.status !== 200) return
  if (!reply.verified) {
    console.warn("[machine-sync] ignored an unsigned or altered preferences reply")
    return
  }
  const body: unknown = await new Response(reply.body).json().catch(() => undefined)
  if (typeof body !== "object" || body === null || !("prefs" in body)) return
  if (body.prefs === null) return { prefs: null }
  const prefs = parsePrefs(body.prefs)
  return prefs && { prefs }
}

type PeerPrefs = NonNullable<Awaited<ReturnType<typeof fetchPeerPrefs>>>

// Main owns the persisted sync settings; the sidecar owns the live gate and
// worker. Every change is written here first and then pushed to the sidecar,
// so a restart always starts from the stored state.
export function createMachineSync(deps: {
  store: SyncStore
  machineName: string
  /** Sends to the sidecar; false when it is not running (the command is dropped). */
  post: (command: SidecarSyncCommand) => boolean
  broadcast: (
    channel: "machine-sync-status" | "machine-sync-peer-prefs" | "machine-sync-adopt-prefs",
    payload: unknown,
  ) => void
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
      configReloadPending: worker?.configReloadPending ?? null,
      gatewayError: state.gatewayError,
      machineName: deps.machineName,
      addresses: deps.lanAddresses(),
    }
  }

  // Best-effort work that outlives the call that started it; `idle` lets tests wait.
  const tasks = new Set<Promise<unknown>>()
  const background = (task: Promise<unknown>) => {
    const tracked = task
      .catch((error: unknown) => console.warn("[machine-sync] background task failed", error))
      .finally(() => tasks.delete(tracked))
    tasks.add(tracked)
  }

  // `keep` (null) has windows restamp and push their prefs. `theirs` hands them
  // the peer's to adopt, falling back to keep if the peer answered with none;
  // if the peer could not be asked, nothing is broadcast (plain newest-wins).
  const announceAdopt = async (choice: MachineSyncPrefsChoice | undefined, fetched: PeerPrefs | undefined) => {
    if (choice !== "theirs") {
      deps.broadcast("machine-sync-adopt-prefs", null)
      return
    }
    if (!fetched) {
      console.warn("[machine-sync] could not read the other computer's preferences; leaving them as is")
      return
    }
    deps.broadcast("machine-sync-adopt-prefs", fetched.prefs)
  }

  const publish = () => deps.broadcast("machine-sync-status", status())

  // Sends a command the sidecar answers with a status carrying the same requestID.
  const request = (command: { type: "sync-now" } | { type: "sync-reload"; force: boolean }) => {
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
      if (deps.post({ ...command, requestID })) return
      // Nobody will answer: report at once instead of waiting out the timeout.
      clearTimeout(timer)
      pending.delete(requestID)
      resolve({ ...status(), lastError: SIDECAR_DOWN })
    })
  }

  return {
    status,
    idle: () => Promise.allSettled([...tasks]).then(() => undefined),
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
      // A code the gateway never received could never pair; say so instead of showing it.
      if (!deps.post({ type: "sync-pairing-code", code, expiresAt }))
        throw new Error(`Cannot create a pairing code: ${SIDECAR_DOWN}`)
      return { code, expiresAt, machineName: deps.machineName, addresses: deps.lanAddresses() }
    },
    async pair(input: { host: string; code: string; prefs?: MachineSyncPrefsChoice }): Promise<MachineSyncPairResult> {
      const result = await pairWithPeer({
        host: input.host,
        code: input.code,
        name: deps.machineName,
        fetchImpl: deps.fetchImpl,
      })
      if (!result.ok) return { ok: false, reason: result.reason }
      // Read the other computer's prefs before storing the peer: storing it
      // starts the sync worker, which could push ours over theirs first. The
      // fetch never throws and is bounded, so pairing still completes (and the
      // peer is stored) when it fails; the broadcast below stays out of the way.
      const fetched = input.prefs === "theirs" ? await fetchPeerPrefs(result.peer, deps.fetchImpl) : undefined
      const previous = settings().peer
      state.worker = undefined
      deps.store.set(SYNC_PEER_KEY, result.peer)
      pushConfig()
      publish()
      background(announceAdopt(input.prefs, fetched))
      // Re-pairing replaces the peer; tell the old one (without waiting) so its token stops working.
      if (previous && previous.token !== result.peer.token)
        background(unpairPeer({ peer: previous, fetchImpl: deps.fetchImpl }))
      if (input.prefs !== "theirs") return { ok: true, prefs: "kept" }
      if (!fetched) return { ok: true, prefs: "unread" }
      return { ok: true, prefs: fetched.prefs ? "adopted" : "kept" }
    },
    async unpair() {
      const peer = settings().peer
      state.worker = undefined
      deps.store.delete(SYNC_PEER_KEY)
      pushConfig()
      publish()
      if (peer) await unpairPeer({ peer, fetchImpl: deps.fetchImpl })
    },
    syncNow: () => request({ type: "sync-now" }),
    /** "Reload to apply": the sidecar reloads instances so a pulled config takes effect. */
    // Without `force` the reload is refused while a chat runs (the status then
    // shows the config still pending with `busy`), so the user can confirm.
    reloadConfig: (input: { force?: boolean } = {}) => request({ type: "sync-reload", force: input.force === true }),
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
        // A sync-config sent before this arrived carried the old (or no) peer
        // and may land after the pairing; resending the stored state wins.
        pushConfig()
        publish()
        return
      }
      if (message.type === "sync-peer-moved") {
        // Only the current peer moves; a late message after a re-pair is dropped.
        if (settings().peer?.token !== message.peer.token) return
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
