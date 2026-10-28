export type ManifestSession = {
  id: string
  parentID: string | null
  timeUpdated: number
  timeArchived: number | null
  busy: boolean
  /** Session retention never deletes this session's tree: it is kept, or a schedule holds it. */
  kept?: boolean
}

/**
 * `root` is set on a retention delete only. Such a tombstone is judged against the whole tree it came from, a manual
 * delete against its own session.
 */
export type Tombstone = { id: string; timeDeleted: number; root?: string }

export type Manifest = {
  schema: string
  app: string
  sessions: ManifestSession[]
  tombstones: Tombstone[]
}

export type SyncAction =
  | { type: "pull"; id: string }
  | { type: "delete"; id: string; timeDeleted: number; root?: string }
  | { type: "archive"; id: string; timeArchived: number }
  | { type: "skip"; id: string; reason: "local-busy" | "peer-busy" }

type Change = Exclude<SyncAction, { type: "skip" }>

// Newest whole-chat copy wins; equal keeps local. Each machine only ever
// writes its own database, so this decides what to pull from the peer.
export function decide(input: { local: Manifest; peer: Manifest }): SyncAction[] {
  const local = new Map(input.local.sessions.map((session) => [session.id, session]))
  const deletedHere = new Map(input.local.tombstones.map((tombstone) => [tombstone.id, tombstone]))
  const peer = new Map(input.peer.sessions.map((session) => [session.id, session]))
  const localTree = trees(input.local.sessions)
  const sides = [localTree, trees(input.peer.sessions)]

  const deletes = input.peer.tombstones.flatMap((tombstone): SyncAction[] => {
    const current = local.get(tombstone.id)
    if (!current) return []
    if (tombstone.root === undefined) {
      if (tombstone.timeDeleted <= current.timeUpdated) return []
      return [guard({ type: "delete", id: tombstone.id, timeDeleted: tombstone.timeDeleted }, current, undefined)]
    }
    if (survives(tombstone, sides)) return []
    // A member of a tree running here waits like a running session.
    const busy = localTree(tombstone.id)?.busy ?? current.busy
    return [
      guard(
        { type: "delete", id: tombstone.id, timeDeleted: tombstone.timeDeleted, root: tombstone.root },
        { ...current, busy },
        undefined,
      ),
    ]
  })
  const changes = input.peer.sessions.flatMap((remote): SyncAction[] => {
    const deleted = deletedHere.get(remote.id)
    // A retention delete here gives way to a peer tree that survives it, and every member comes back with the tree.
    const restore = deleted?.root !== undefined && survives(deleted, sides)
    const change = sessionChange(remote, local.get(remote.id), restore ? undefined : deleted?.timeDeleted, restore)
    return change ? [guard(change, local.get(remote.id), remote)] : []
  })
  const pulls = parentsFirst(
    changes.filter((action): action is { type: "pull"; id: string } => action.type === "pull"),
    peer,
  )
  return [...deletes, ...pulls, ...changes.filter((action) => action.type !== "pull")]
}

function sessionChange(
  remote: ManifestSession,
  current: ManifestSession | undefined,
  deletedAt: number | undefined,
  restore: boolean,
): Change | undefined {
  if (remote.timeArchived !== null) {
    // Archived chats stay local: a peer-archived chat missing here is never pulled, unless it is a member of a tree
    // this machine's retention deleted and the peer kept.
    if (!current) return restore ? { type: "pull", id: remote.id } : undefined
    // Newer peer content wins; the bundle carries time_archived, so pulling archives it too.
    if (remote.timeUpdated > current.timeUpdated) return { type: "pull", id: remote.id }
    if (current.timeArchived !== null) return
    if (remote.timeArchived <= current.timeUpdated) return
    return { type: "archive", id: remote.id, timeArchived: remote.timeArchived }
  }
  if (deletedAt !== undefined && deletedAt >= remote.timeUpdated) return
  if (!current) return { type: "pull", id: remote.id }
  if (current.timeArchived !== null)
    return remote.timeUpdated > current.timeArchived ? { type: "pull", id: remote.id } : undefined
  return remote.timeUpdated > current.timeUpdated ? { type: "pull", id: remote.id } : undefined
}

type TreeState = { latest: number; kept: boolean; busy: boolean }

/**
 * Each session's tree in one manifest: its newest activity, and whether any member is kept or running. A tree is
 * keyed by its top, the topmost ancestor present in the manifest, so each side computes it from its own rows. Returns
 * a lookup by member id, undefined for a session the manifest does not have.
 */
function trees(sessions: ManifestSession[]) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  // A hostile peer manifest may contain parent cycles; stop at the first repeat.
  const top = (id: string, seen = new Set<string>()): string => {
    const parentID = byID.get(id)?.parentID
    if (!parentID || !byID.has(parentID) || seen.has(parentID)) return id
    return top(parentID, seen.add(id))
  }
  const tops = new Map(sessions.map((session) => [session.id, top(session.id)]))
  const states = sessions.reduce((result, session) => {
    const key = tops.get(session.id) ?? session.id
    const state = result.get(key)
    return result.set(key, {
      latest: Math.max(state?.latest ?? 0, session.timeUpdated),
      kept: (state?.kept ?? false) || session.kept === true,
      busy: (state?.busy ?? false) || session.busy,
    })
  }, new Map<string, TreeState>())
  return (id: string) => {
    const key = tops.get(id)
    return key === undefined ? undefined : states.get(key)
  }
}

/**
 * Whether a retention tombstone's tree survives it: on either side, the tree holding the deleted session or the root
 * it names is kept, or has activity at or after the tombstone. Its basis is the deleter's newest activity plus 1 ms,
 * so that activity is newer than anything the deleter saw. A surviving tree keeps every member on every machine: no
 * peer deletes one, the deleter does not push the delete, and it pulls each member back.
 */
function survives(tombstone: Tombstone, sides: Array<(id: string) => TreeState | undefined>) {
  return sides
    .flatMap((tree) => [tree(tombstone.id), tombstone.root === undefined ? undefined : tree(tombstone.root)])
    .some((state) => state !== undefined && (state.kept || state.latest >= tombstone.timeDeleted))
}

function guard(change: Change, current: ManifestSession | undefined, remote: ManifestSession | undefined): SyncAction {
  if (current?.busy) return { type: "skip", id: change.id, reason: "local-busy" }
  if (remote?.busy) return { type: "skip", id: change.id, reason: "peer-busy" }
  return change
}

function parentsFirst(pulls: Array<{ type: "pull"; id: string }>, peer: Map<string, ManifestSession>) {
  const pending = new Map(pulls.map((action) => [action.id, action]))
  const ordered: Array<{ type: "pull"; id: string }> = []
  const visit = (id: string, seen: Set<string>) => {
    const action = pending.get(id)
    if (!action || seen.has(id)) return
    seen.add(id)
    const parentID = peer.get(id)?.parentID
    if (parentID) visit(parentID, seen)
    pending.delete(id)
    ordered.push(action)
  }
  pulls.forEach((action) => visit(action.id, new Set()))
  return ordered
}

export function isManifest(value: unknown): value is Manifest {
  if (!isRecord(value) || typeof value.schema !== "string" || typeof value.app !== "string") return false
  if (!Array.isArray(value.sessions) || !Array.isArray(value.tombstones)) return false
  return (
    value.sessions.every(isManifestSession) &&
    value.tombstones.every(
      (tombstone) =>
        isRecord(tombstone) &&
        typeof tombstone.id === "string" &&
        isFiniteNumber(tombstone.timeDeleted) &&
        (tombstone.root === undefined || typeof tombstone.root === "string"),
    )
  )
}

function isManifestSession(value: unknown): value is ManifestSession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isFiniteNumber(value.timeUpdated) &&
    typeof value.busy === "boolean" &&
    (value.kept === undefined || typeof value.kept === "boolean") &&
    (value.parentID === null || typeof value.parentID === "string") &&
    (value.timeArchived === null || isFiniteNumber(value.timeArchived))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export type PushAction =
  | { type: "push"; id: string }
  | { type: "delete"; id: string; timeDeleted: number; root?: string }
  | { type: "archive"; id: string; timeArchived: number }
  | { type: "skip"; id: string; reason: "local-busy" | "peer-busy" }

export function decidePush(input: { local: Manifest; hub: Manifest }): PushAction[] {
  const hub = new Map(input.hub.sessions.map((session) => [session.id, session]))
  const sides = [trees(input.local.sessions), trees(input.hub.sessions)]
  const out: PushAction[] = []
  for (const current of input.local.sessions) {
    const remote = hub.get(current.id)
    if (remote && remote.busy) {
      out.push({ type: "skip", id: current.id, reason: "peer-busy" })
      continue
    }
    if (current.busy) {
      out.push({ type: "skip", id: current.id, reason: "local-busy" })
      continue
    }
    if (!remote) {
      if (current.timeArchived !== null) continue
      out.push({ type: "push", id: current.id })
      continue
    }
    if (current.timeUpdated > remote.timeUpdated) out.push({ type: "push", id: current.id })
  }
  for (const tombstone of input.local.tombstones) {
    const remote = hub.get(tombstone.id)
    if (!remote) continue
    // A retention delete reaches the hub only while no side has its tree newer or kept; see `survives`.
    if (tombstone.root === undefined && tombstone.timeDeleted > remote.timeUpdated)
      out.push({ type: "delete", id: tombstone.id, timeDeleted: tombstone.timeDeleted })
    if (tombstone.root !== undefined && !survives(tombstone, sides))
      out.push({ type: "delete", id: tombstone.id, timeDeleted: tombstone.timeDeleted, root: tombstone.root })
  }
  return out
}
