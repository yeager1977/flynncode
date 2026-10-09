import { decide, isManifest, type Manifest, type SyncAction } from "./sync-decide.ts"
import type { SyncPeer, SyncPrefs } from "./sync-gate.ts"

export const POLL_MS = 60_000
export const BACKOFF_MS = 5 * 60_000
export const BACKOFF_AFTER_FAILURES = 5
export const BATCH_SIZE = 20
export const BATCH_DELAY_MS = 1_000
const REQUEST_TIMEOUT_MS = 60_000

export type SyncPhase = "idle" | "offline" | "mismatch" | "unauthorized" | "paused" | "unpaired"

export type SyncStatus = {
  phase: SyncPhase
  online: boolean
  lastSuccess: number | null
  received: number
  sent: number
  missingDirectories: string[]
  backlog: { done: number; total: number } | null
  failures: Array<{ id: string; error: string }>
  skipped: Array<{ id: string; reason: "local-busy" | "peer-busy" }>
  lastError: string | null
  consecutiveFailures: number
}

export type SyncWorker = ReturnType<typeof createSyncWorker>

// "unreachable" means no response or a gateway-level outage (502/503/504); any
// other HTTP error is "error" and belongs to the one request that produced it.
type Fetched<T> =
  | { kind: "ok"; value: T }
  | { kind: "unauthorized" }
  | { kind: "unreachable" }
  | { kind: "error"; status: number }
  | { kind: "invalid" }

const LOCAL_UNAVAILABLE = "local server unavailable"

export function initialStatus(): SyncStatus {
  return {
    phase: "unpaired",
    online: false,
    lastSuccess: null,
    received: 0,
    sent: 0,
    missingDirectories: [],
    backlog: null,
    failures: [],
    skipped: [],
    lastError: null,
    consecutiveFailures: 0,
  }
}

export function nextDelay(
  status: SyncStatus,
  timing = { pollMs: POLL_MS, backoffMs: BACKOFF_MS, batchDelayMs: BATCH_DELAY_MS },
) {
  // Only a cycle that is still making progress is worth following up quickly; a
  // stale backlog must never defeat the poll or backoff delay.
  if (status.phase === "idle" && status.backlog && status.received > 0) return timing.batchDelayMs
  if (status.consecutiveFailures >= BACKOFF_AFTER_FAILURES) return timing.backoffMs
  return timing.pollMs
}

// Pulls from the paired machine through its gateway and writes only through
// this machine's own server, so each side only ever changes its own database.
export function createSyncWorker(options: {
  local: { url: string; authorization: string }
  peer: () => SyncPeer | undefined
  paused: () => boolean
  prefs: { get(): SyncPrefs | undefined; apply(prefs: SyncPrefs): void }
  takeSent: () => number
  onStatus: (status: SyncStatus) => void
  fetchImpl?: typeof fetch
  now?: () => number
  pollMs?: number
  backoffMs?: number
  batchDelayMs?: number
}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const timing = {
    pollMs: options.pollMs ?? POLL_MS,
    backoffMs: options.backoffMs ?? BACKOFF_MS,
    batchDelayMs: options.batchDelayMs ?? BATCH_DELAY_MS,
  }
  const state = {
    status: initialStatus(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    running: undefined as Promise<SyncStatus> | undefined,
    // Chats whose last pull failed or was busy; they go to the back of the batch
    // so a few stuck chats cannot starve the rest of a backlog.
    stuck: new Set<string>(),
    stopped: true,
  }

  const send = (url: string, authorization: string, body?: unknown) =>
    fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { authorization } : { authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => undefined)
  const local = (path: string, body?: unknown) => send(`${options.local.url}${path}`, options.local.authorization, body)
  const remote = (peer: SyncPeer, path: string) => send(`${peer.url}${path}`, `Bearer ${peer.token}`)

  async function runCycle(): Promise<SyncStatus> {
    const previous = state.status
    const peer = options.peer()
    if (!peer) return initialStatus()
    if (options.paused()) return { ...previous, phase: "paused", backlog: null }
    const localManifest = await read(local("/flynncode-sync/manifest"), isManifest)
    if (localManifest.kind !== "ok") return localDown(previous)
    const peerManifest = await read(remote(peer, "/flynncode-sync/manifest"), isManifest)
    if (peerManifest.kind === "unauthorized")
      return { ...previous, phase: "unauthorized", online: true, backlog: null, consecutiveFailures: 0 }
    if (peerManifest.kind !== "ok") return unreachable(previous, previous.received)
    if (localManifest.value.schema !== peerManifest.value.schema || localManifest.value.app !== peerManifest.value.app)
      return { ...previous, phase: "mismatch", online: true, backlog: null, consecutiveFailures: 0 }

    const actions = decide({ local: localManifest.value, peer: peerManifest.value })
    const pulls = actions.filter((action): action is Extract<SyncAction, { type: "pull" }> => action.type === "pull")
    const pullIDs = new Set(pulls.map((pull) => pull.id))
    ;[...state.stuck].filter((id) => !pullIDs.has(id)).forEach((id) => state.stuck.delete(id))
    const batch = pullOrder(pulls, peerManifest.value, state.stuck).slice(0, BATCH_SIZE)
    // Requests run one at a time so a big first sync never floods either side.
    const results: Array<{ id: string; outcome: string }> = []
    for (const action of actions) {
      if (action.type !== "delete" && action.type !== "archive") continue
      const outcome =
        action.type === "delete"
          ? await write(`/flynncode-sync/delete/${encodeURIComponent(action.id)}`, { timeDeleted: action.timeDeleted })
          : await write(`/flynncode-sync/archive/${encodeURIComponent(action.id)}`, {
              timeArchived: action.timeArchived,
            })
      if (outcome === LOCAL_UNAVAILABLE) return localDown(previous)
      results.push({ id: action.id, outcome })
    }
    const parents = new Map(peerManifest.value.sessions.map((item) => [item.id, item.parentID]))
    // A chat is never applied while its pulled parent is unresolved this cycle.
    const blocked = new Set(actions.flatMap((action) => (action.type === "skip" ? [action.id] : [])))
    const pulled: Array<{ id: string; outcome: string }> = []
    const deferred: string[] = []
    for (const action of batch) {
      const parentID = parents.get(action.id)
      if (parentID && blocked.has(parentID)) {
        blocked.add(action.id)
        state.stuck.add(action.id)
        deferred.push(action.id)
        continue
      }
      const result = await pull(peer, action.id)
      if ("abort" in result) {
        const received = pulled.filter((item) => item.outcome === "applied").length
        if (result.abort === "unauthorized")
          return { ...previous, phase: "unauthorized", online: true, backlog: null, received, consecutiveFailures: 0 }
        return unreachable(previous, received)
      }
      if (result.outcome === LOCAL_UNAVAILABLE) return localDown(previous)
      pulled.push({ id: action.id, outcome: result.outcome })
      if (result.outcome === "applied") state.stuck.delete(action.id)
      else {
        state.stuck.add(action.id)
        blocked.add(action.id)
      }
    }

    const received = pulled.filter((result) => result.outcome === "applied").length
    const failures = [...results, ...pulled]
      .filter((result) => result.outcome !== "applied" && result.outcome !== "busy")
      .map((result) => ({ id: result.id, error: result.outcome }))
    const skipped = [
      ...actions.flatMap((action) => (action.type === "skip" ? [{ id: action.id, reason: action.reason }] : [])),
      ...[...results, ...pulled]
        .filter((result) => result.outcome === "busy")
        .map((result) => ({ id: result.id, reason: "local-busy" as const })),
      // Waiting for a parent that is still unresolved is the same as the chat being busy.
      ...deferred.map((id) => ({ id, reason: "local-busy" as const })),
    ]
    const settingsError = await syncSettings(peer)
    await syncPrefs(peer)
    const missing = await read(local("/flynncode-sync/missing"), isMissing)
    return {
      phase: "idle",
      online: true,
      lastSuccess: now(),
      received,
      sent: options.takeSent(),
      missingDirectories: missing.kind === "ok" ? missing.value.directories : previous.missingDirectories,
      backlog:
        pulls.length > batch.length
          ? { total: previous.backlog?.total ?? pulls.length, done: (previous.backlog?.done ?? 0) + received }
          : null,
      failures,
      skipped,
      lastError: settingsError,
      consecutiveFailures: 0,
    }
  }

  async function write(path: string, body: unknown): Promise<string> {
    const response = await local(path, body)
    if (!response || [502, 503, 504].includes(response.status)) return LOCAL_UNAVAILABLE
    if (response.status === 409) return "busy"
    if (response.ok) return "applied"
    return `${response.status} ${await response.text().catch(() => "")}`.trim()
  }

  async function pull(
    peer: SyncPeer,
    id: string,
  ): Promise<{ outcome: string } | { abort: "unreachable" | "unauthorized" }> {
    const bundle = await read(remote(peer, `/flynncode-sync/session/${encodeURIComponent(id)}`), isRecord)
    // An unreachable or unauthorized peer ends the cycle instead of failing every remaining chat.
    if (bundle.kind === "unreachable" || bundle.kind === "unauthorized") return { abort: bundle.kind }
    // Any other HTTP error is this chat's own failure; the rest of the batch continues.
    if (bundle.kind === "error") return { outcome: `fetch failed (HTTP ${bundle.status})` }
    if (bundle.kind !== "ok") return { outcome: `fetch failed (${bundle.kind})` }
    return { outcome: await write("/flynncode-sync/apply", bundle.value) }
  }

  async function syncSettings(peer: SyncPeer): Promise<string | null> {
    const settings = await read(remote(peer, "/flynncode-sync/settings"), isSettings)
    if (settings.kind !== "ok" || settings.value.config === null) return null
    // A null local config is either a missing file (a fresh machine, safe to
    // fill) or an unparseable one, which must never be overwritten.
    const here = await read(local("/flynncode-sync/settings"), isSettings)
    if (here.kind !== "ok" || (here.value.config === null && here.value.missing !== true)) return null
    const outcome = await write("/flynncode-sync/settings/apply", {
      config: settings.value.config,
      mtime: settings.value.mtime,
    })
    return outcome === "applied" ? null : `settings: ${outcome}`
  }

  async function syncPrefs(peer: SyncPeer) {
    const result = await read(remote(peer, "/flynncode-sync/prefs"), isPrefsPayload)
    if (result.kind !== "ok" || result.value.prefs === null) return
    if (result.value.prefs.updatedAt <= (options.prefs.get()?.updatedAt ?? 0)) return
    options.prefs.apply(result.value.prefs)
  }

  function localDown(previous: SyncStatus): SyncStatus {
    return { ...previous, phase: "offline", online: false, backlog: null, lastError: LOCAL_UNAVAILABLE }
  }

  function unreachable(previous: SyncStatus, received: number): SyncStatus {
    return {
      ...previous,
      phase: "offline",
      online: false,
      backlog: null,
      received,
      consecutiveFailures: previous.consecutiveFailures + 1,
    }
  }

  async function cycle() {
    const status = await runCycle()
    state.status = status
    options.onStatus(status)
    return status
  }

  function schedule() {
    if (state.stopped) return
    clearTimeout(state.timer)
    state.timer = setTimeout(() => void run(), nextDelay(state.status, timing))
    state.timer.unref?.()
  }

  function run() {
    if (state.running) return state.running
    state.running = cycle().finally(() => {
      state.running = undefined
      schedule()
    })
    return state.running
  }

  return {
    cycle: run,
    start() {
      state.stopped = false
      state.stuck.clear()
      void run()
    },
    stop() {
      state.stopped = true
      state.stuck.clear()
      clearTimeout(state.timer)
    },
    syncNow: () => (state.running ? state.running.then(() => run()) : run()),
    status: () => state.status,
  }
}

// Never-stuck chat families come first, stuck ones after. A family is a pulled
// chat plus its pulled ancestors, kept in decide's parents-first order so a
// child never precedes its parent in the batch.
function pullOrder(pulls: Array<{ type: "pull"; id: string }>, peer: Manifest, stuck: Set<string>) {
  const parents = new Map(peer.sessions.map((item) => [item.id, item.parentID]))
  const pulling = new Set(pulls.map((pull) => pull.id))
  // A hostile peer manifest may contain parent cycles; stop at the first repeat.
  const root = (id: string, seen = new Set<string>()): string => {
    const parentID = parents.get(id)
    if (!parentID || !pulling.has(parentID) || seen.has(parentID)) return id
    return root(parentID, seen.add(id))
  }
  const families = Map.groupBy(pulls, (pull) => root(pull.id))
  const ordered = [...families.values()]
  return [
    ...ordered.filter((family) => !family.some((pull) => stuck.has(pull.id))),
    ...ordered.filter((family) => family.some((pull) => stuck.has(pull.id))),
  ].flat()
}

async function read<T>(
  pending: Promise<Response | undefined>,
  guard: (value: unknown) => value is T,
): Promise<Fetched<T>> {
  const response = await pending
  if (!response) return { kind: "unreachable" }
  if (response.status === 401) return { kind: "unauthorized" }
  if ([502, 503, 504].includes(response.status)) return { kind: "unreachable" }
  if (!response.ok) return { kind: "error", status: response.status }
  const body: unknown = await response.json().catch(() => undefined)
  return guard(body) ? { kind: "ok", value: body } : { kind: "invalid" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(value: unknown): value is { directories: string[] } {
  return (
    isRecord(value) && Array.isArray(value.directories) && value.directories.every((item) => typeof item === "string")
  )
}

function isSettings(
  value: unknown,
): value is { config: Record<string, unknown> | null; mtime: number; missing?: boolean } {
  return isRecord(value) && (value.config === null || isRecord(value.config)) && typeof value.mtime === "number"
}

function isPrefsPayload(value: unknown): value is { prefs: SyncPrefs | null } {
  if (!isRecord(value)) return false
  if (value.prefs === null) return true
  return isRecord(value.prefs) && isRecord(value.prefs.sections) && typeof value.prefs.updatedAt === "number"
}
