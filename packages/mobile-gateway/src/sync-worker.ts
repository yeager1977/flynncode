import { decide, decidePush, isManifest, type Manifest, type ManifestSession, type SyncAction } from "./sync-decide.ts"
import type { SyncPeer, SyncPrefs } from "./sync-gate.ts"
import { signedRequest } from "./sync-sign.ts"

export const POLL_MS = 60_000
export const BACKOFF_MS = 5 * 60_000
export const BACKOFF_AFTER_FAILURES = 5
export const BATCH_SIZE = 20
export const BATCH_DELAY_MS = 1_000
const REQUEST_TIMEOUT_MS = 60_000

// "peer-paused": the other computer answered, but its sync is paused.
// "clock-skew": the peer refused our signed requests because the two clocks
// differ by more than the signature window.
export type SyncPhase =
  | "idle"
  | "offline"
  | "mismatch"
  | "unauthorized"
  | "paused"
  | "peer-paused"
  | "clock-skew"
  | "unpaired"

// Why a chat waits for the next cycle: it runs here, it runs on the peer, or it
// changed here after this cycle read the manifest.
export type SkipReason = "local-busy" | "peer-busy" | "local-changed"

export type SyncStatus = {
  phase: SyncPhase
  online: boolean
  lastSuccess: number | null
  received: number
  sent: number
  missingDirectories: string[]
  backlog: { done: number; total: number } | null
  failures: Array<{ id: string; error: string }>
  skipped: Array<{ id: string; reason: SkipReason }>
  lastError: string | null
  consecutiveFailures: number
  /** A pulled global config waits for "Reload to apply"; `from` names the machine it came from. */
  // `busy`: a chat is running here, so reloading would stop it.
  configReloadPending: { from: string; busy: boolean } | null
}

export type SyncWorker = ReturnType<typeof createSyncWorker>

// "unreachable" means no response or a gateway-level outage (502/503/504);
// "paused" is the peer gateway's own 503 while its sync is paused. Any other
// HTTP error is "error" and belongs to the one request that produced it.
type Fetched<T> =
  | { kind: "ok"; value: T }
  | { kind: "unauthorized" }
  // The peer refused a request signed with our token because of its time.
  | { kind: "clock" }
  | { kind: "unreachable" }
  | { kind: "paused" }
  | { kind: "error"; status: number }
  | { kind: "invalid" }
  // The peer's answer is unsigned or its signature does not match: never used.
  | { kind: "unverified" }

const LOCAL_UNAVAILABLE = "local server unavailable"
const UNVERIFIED = "the other computer's reply failed verification"
// Write outcomes that skip a chat for this cycle instead of failing it.
const SKIPS = new Map<string, SkipReason>([
  ["busy", "local-busy"],
  ["stale", "local-changed"],
  ["peer-busy", "peer-busy"],
])

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
    configReloadPending: null,
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
  // Requests to the peer are signed with the token (never sent), and its
  // answers, refusals included, are only used once their signature checks
  // out. An unsigned 401 could come from anyone on the path, so it counts as
  // no answer rather than "pair again".
  const remote = async (peer: SyncPeer, path: string) => {
    const reply = await signedRequest({ peer, path, timeoutMs: REQUEST_TIMEOUT_MS, fetchImpl })
    if (!reply) return undefined
    if (reply.verified) return new Response(reply.body, { status: reply.status })
    console.warn(`[machine-sync] ignored an unsigned or altered reply (HTTP ${reply.status}) for ${path}`)
    return reply.status === 401 ? undefined : ("unverified" as const)
  }

  const signedPost = async (peer: SyncPeer, path: string, body: unknown) => {
    const reply = await signedRequest({
      peer,
      path,
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: REQUEST_TIMEOUT_MS,
      fetchImpl,
    })
    if (!reply) return undefined
    if (reply.verified) return new Response(reply.body, { status: reply.status })
    console.warn(`[machine-sync] ignored an unsigned or altered reply (HTTP ${reply.status}) for ${path}`)
    return reply.status === 401 ? undefined : ("unverified" as const)
  }

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
    if (peerManifest.kind === "clock") return clockSkew(previous, previous.received)
    // A paused peer is reachable, so it neither counts as an outage nor backs off.
    if (peerManifest.kind === "paused") return peerPaused(previous, previous.received)
    if (peerManifest.kind === "unverified")
      return { ...unreachable(previous, previous.received), lastError: UNVERIFIED }
    if (peerManifest.kind !== "ok") return unreachable(previous, previous.received)
    if (localManifest.value.schema !== peerManifest.value.schema || localManifest.value.app !== peerManifest.value.app)
      return { ...previous, phase: "mismatch", online: true, backlog: null, consecutiveFailures: 0 }

    const actions = decide({ local: localManifest.value, peer: peerManifest.value })
    // Every write carries what this cycle saw of the local chat, so the local
    // server refuses it if the chat changed in the meantime.
    const seen = new Map(localManifest.value.sessions.map((item) => [item.id, item]))
    const expected = (id: string) => version(seen.get(id))
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
          ? await write(`/flynncode-sync/delete/${encodeURIComponent(action.id)}`, {
              timeDeleted: action.timeDeleted,
              expected: expected(action.id),
            })
          : await write(`/flynncode-sync/archive/${encodeURIComponent(action.id)}`, {
              timeArchived: action.timeArchived,
              expected: expected(action.id),
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
      const result = await pull(peer, action.id, expected(action.id))
      if ("abort" in result) {
        const received = pulled.filter((item) => item.outcome === "applied").length
        if (result.abort === "unauthorized")
          return { ...previous, phase: "unauthorized", online: true, backlog: null, received, consecutiveFailures: 0 }
        if (result.abort === "clock") return clockSkew(previous, received)
        if (result.abort === "paused") return peerPaused(previous, received)
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
    const pushActions = decidePush({ local: localManifest.value, hub: peerManifest.value })
    const hubSeen = new Map(peerManifest.value.sessions.map((item) => [item.id, item]))
    const hubExpected = (id: string) => version(hubSeen.get(id))
    const pushed: Array<{ id: string; outcome: string }> = []
    const pushSkips: SyncStatus["skipped"] = []
    let pushAbort: { abort: "unreachable" | "unauthorized" | "paused" | "clock" } | undefined = undefined
    for (const action of pushActions.slice(0, BATCH_SIZE)) {
      if (pushAbort) break
      if (action.type === "skip") {
        pushSkips.push({ id: action.id, reason: action.reason })
        continue
      }
      if (action.type === "push") {
        const localBundle = await read(local(`/flynncode-sync/session/${encodeURIComponent(action.id)}`), isRecord)
        if (localBundle.kind !== "ok") continue
        const result = await pushOne(peer, "/flynncode-sync/apply", {
          bundle: localBundle.value,
          expected: hubExpected(action.id),
        })
        if ("abort" in result) pushAbort = result
        else pushed.push({ id: action.id, outcome: result.outcome })
        continue
      }
      const result =
        action.type === "delete"
          ? await pushOne(peer, `/flynncode-sync/delete/${encodeURIComponent(action.id)}`, {
              timeDeleted: action.timeDeleted,
              expected: hubExpected(action.id),
            })
          : await pushOne(peer, `/flynncode-sync/archive/${encodeURIComponent(action.id)}`, {
              timeArchived: action.timeArchived,
              expected: hubExpected(action.id),
            })
      if ("abort" in result) pushAbort = result
      else pushed.push({ id: action.id, outcome: result.outcome })
    }
    if (pushAbort) {
      if (pushAbort.abort === "unauthorized")
        return { ...previous, phase: "unauthorized", online: true, backlog: null, received, consecutiveFailures: 0 }
      if (pushAbort.abort === "clock") return clockSkew(previous, received)
      if (pushAbort.abort === "paused") return peerPaused(previous, received)
      return unreachable(previous, received)
    }

    const failures = [...results, ...pulled, ...pushed]
      .filter((result) => result.outcome !== "applied" && !SKIPS.has(result.outcome))
      .map((result) => ({ id: result.id, error: result.outcome }))
    const skipped: SyncStatus["skipped"] = [
      ...actions.flatMap((action) => (action.type === "skip" ? [{ id: action.id, reason: action.reason }] : [])),
      ...pushSkips,
      ...[...results, ...pulled, ...pushed].flatMap((result) => {
        const reason = SKIPS.get(result.outcome)
        return reason ? [{ id: result.id, reason }] : []
      }),
      // Waiting for a parent that is still unresolved is the same as the chat being busy.
      ...deferred.map((id) => ({ id, reason: "local-busy" as const })),
    ]
    const settingsError = await syncSettings(peer)
    await syncPrefs(peer)
    const missing = await read(local("/flynncode-sync/missing"), isMissing)
    const reload = await read(local("/flynncode-sync/reload"), isReloadState)
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
      configReloadPending: reload.kind === "ok" ? pendingReload(reload.value) : previous.configReloadPending,
    }
  }

  // "busy" (the chat runs here) and "stale" (it changed since the manifest)
  // are both a 409 from the local server; the body tells them apart.
  async function write(path: string, body: unknown): Promise<string> {
    const response = await local(path, body)
    if (!response || [502, 503, 504].includes(response.status)) return LOCAL_UNAVAILABLE
    if (response.status === 409) {
      const reply: unknown = await response.json().catch(() => undefined)
      return isRecord(reply) && reply.error === "stale" ? "stale" : "busy"
    }
    if (response.ok) return "applied"
    return `${response.status} ${await response.text().catch(() => "")}`.trim()
  }

  async function pull(
    peer: SyncPeer,
    id: string,
    expected: Version | null,
  ): Promise<{ outcome: string } | { abort: "unreachable" | "unauthorized" | "paused" | "clock" }> {
    const bundle = await read(remote(peer, `/flynncode-sync/session/${encodeURIComponent(id)}`), isRecord)
    // An unreachable, unauthorized or paused peer ends the cycle instead of failing every remaining chat.
    if (
      bundle.kind === "unreachable" ||
      bundle.kind === "unauthorized" ||
      bundle.kind === "paused" ||
      bundle.kind === "clock"
    )
      return { abort: bundle.kind }
    // The chat started running on the peer after its manifest was read; it is
    // skipped like a chat the manifest already showed busy.
    if (bundle.kind === "error" && bundle.status === 409) return { outcome: "peer-busy" }
    // Any other HTTP error is this chat's own failure; the rest of the batch continues.
    if (bundle.kind === "error") return { outcome: `fetch failed (HTTP ${bundle.status})` }
    if (bundle.kind === "unverified") return { outcome: `fetch failed (${UNVERIFIED})` }
    if (bundle.kind !== "ok") return { outcome: `fetch failed (${bundle.kind})` }
    return { outcome: await write("/flynncode-sync/apply", { bundle: bundle.value, expected }) }
  }

  async function pushOne(
    peer: SyncPeer,
    path: string,
    body: unknown,
  ): Promise<{ outcome: string } | { abort: "unreachable" | "unauthorized" | "paused" | "clock" }> {
    const response = await signedPost(peer, path, body)
    if (!response) return { abort: "unreachable" }
    if (response === "unverified") return { outcome: `push failed (${UNVERIFIED})` }
    if (response.status === 401) {
      const reply: unknown = await response.json().catch(() => undefined)
      if (isRecord(reply) && reply.error === "clock") return { abort: "clock" }
      return isRecord(reply) && reply.error === "revoked" ? { abort: "unauthorized" } : { abort: "unreachable" }
    }
    if (response.status === 503) {
      const reply: unknown = await response.json().catch(() => undefined)
      return isRecord(reply) && reply.error === "paused" ? { abort: "paused" } : { abort: "unreachable" }
    }
    if ([502, 504].includes(response.status)) return { abort: "unreachable" }
    if (response.status === 409) {
      const reply: unknown = await response.json().catch(() => undefined)
      return isRecord(reply) && reply.error === "stale" ? { outcome: "stale" } : { outcome: "peer-busy" }
    }
    if (!response.ok) return { outcome: `push failed (HTTP ${response.status})` }
    return { outcome: "applied" }
  }

  async function syncSettings(peer: SyncPeer): Promise<string | null> {
    const settings = await read(remote(peer, "/flynncode-sync/settings"), isSettings)
    if (settings.kind === "unverified") return `settings: ${UNVERIFIED}`
    if (settings.kind !== "ok" || settings.value.config === null) return null
    // A null local config is either a missing file (a fresh machine, safe to
    // fill) or an unparseable one, which must never be overwritten.
    const here = await read(local("/flynncode-sync/settings"), isSettings)
    if (here.kind !== "ok" || (here.value.config === null && here.value.missing !== true)) return null
    const outcome = await write("/flynncode-sync/settings/apply", {
      config: settings.value.config,
      mtime: settings.value.mtime,
      from: peer.name,
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

  // Reachable, but every signed request is refused until the clocks agree.
  function clockSkew(previous: SyncStatus, received: number): SyncStatus {
    return { ...previous, phase: "clock-skew", online: true, backlog: null, received, consecutiveFailures: 0 }
  }

  function peerPaused(previous: SyncStatus, received: number): SyncStatus {
    return { ...previous, phase: "peer-paused", online: true, backlog: null, received, consecutiveFailures: 0 }
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

  // Cycles and reloads run one at a time, in order, so a cycle that read the
  // pending reload before a reload finished can never report it again after.
  function exclusive(work: () => Promise<SyncStatus>) {
    const task = (state.running ?? Promise.resolve()).then(work, work)
    const tracked: Promise<SyncStatus> = task.finally(() => {
      if (state.running !== tracked) return
      state.running = undefined
      schedule()
    })
    state.running = tracked
    return tracked
  }

  function run() {
    return state.running ?? exclusive(cycle)
  }

  // A refused reload (a chat is running and `force` is off) leaves the config
  // pending with `busy` set, so the user can be asked first.
  async function reload(force: boolean) {
    const response = await local("/flynncode-sync/reload", { force })
    const after = await read(local("/flynncode-sync/reload"), isReloadState)
    const failed = !response || (!response.ok && response.status !== 409)
    state.status = {
      ...state.status,
      configReloadPending: after.kind === "ok" ? pendingReload(after.value) : state.status.configReloadPending,
      lastError: failed ? "the settings could not be reloaded" : state.status.lastError,
    }
    options.onStatus(state.status)
    return state.status
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
    /** "Reload to apply": reloads this machine's instances so a pulled config takes effect. */
    reloadConfig: (input: { force?: boolean } = {}) => exclusive(() => reload(input.force === true)),
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

type Version = { timeUpdated: number; timeArchived: number | null }

// null tells the local server the chat must not exist there yet.
function version(session: ManifestSession | undefined): Version | null {
  return session ? { timeUpdated: session.timeUpdated, timeArchived: session.timeArchived } : null
}

async function read<T>(
  pending: Promise<Response | "unverified" | undefined>,
  guard: (value: unknown) => value is T,
): Promise<Fetched<T>> {
  const response = await pending
  if (!response) return { kind: "unreachable" }
  if (response === "unverified") return { kind: "unverified" }
  // Only a signed refusal reaches here from the peer: "revoked" means pair
  // again, "clock" means the clocks differ; anything else is a passing fault.
  if (response.status === 401) {
    const body: unknown = await response.json().catch(() => undefined)
    if (isRecord(body) && body.error === "clock") return { kind: "clock" }
    return isRecord(body) && body.error === "revoked" ? { kind: "unauthorized" } : { kind: "unreachable" }
  }
  if (response.status === 503) {
    const body: unknown = await response.json().catch(() => undefined)
    return isRecord(body) && body.error === "paused" ? { kind: "paused" } : { kind: "unreachable" }
  }
  if ([502, 504].includes(response.status)) return { kind: "unreachable" }
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

type ReloadState = { pending: { from: string } | null; busy: boolean }

function isReloadState(value: unknown): value is ReloadState {
  if (!isRecord(value) || typeof value.busy !== "boolean") return false
  return value.pending === null || (isRecord(value.pending) && typeof value.pending.from === "string")
}

function pendingReload(value: ReloadState) {
  return value.pending ? { from: value.pending.from, busy: value.busy } : null
}

function isPrefsPayload(value: unknown): value is { prefs: SyncPrefs | null } {
  if (!isRecord(value)) return false
  if (value.prefs === null) return true
  return isRecord(value.prefs) && isRecord(value.prefs.sections) && typeof value.prefs.updatedAt === "number"
}
