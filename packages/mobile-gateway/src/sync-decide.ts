export type ManifestSession = {
  id: string
  parentID: string | null
  timeUpdated: number
  timeArchived: number | null
  busy: boolean
}

export type Manifest = {
  schema: string
  app: string
  sessions: ManifestSession[]
  tombstones: Array<{ id: string; timeDeleted: number }>
}

export type SyncAction =
  | { type: "pull"; id: string }
  | { type: "delete"; id: string; timeDeleted: number }
  | { type: "archive"; id: string; timeArchived: number }
  | { type: "skip"; id: string; reason: "local-busy" | "peer-busy" }

type Change = Exclude<SyncAction, { type: "skip" }>

// Newest whole-chat copy wins; equal keeps local. Each machine only ever
// writes its own database, so this decides what to pull from the peer.
export function decide(input: { local: Manifest; peer: Manifest }): SyncAction[] {
  const local = new Map(input.local.sessions.map((session) => [session.id, session]))
  const deletedHere = new Map(input.local.tombstones.map((tombstone) => [tombstone.id, tombstone.timeDeleted]))
  const peer = new Map(input.peer.sessions.map((session) => [session.id, session]))

  const deletes = input.peer.tombstones.flatMap((tombstone): SyncAction[] => {
    const current = local.get(tombstone.id)
    if (!current || tombstone.timeDeleted <= current.timeUpdated) return []
    return [guard({ type: "delete", id: tombstone.id, timeDeleted: tombstone.timeDeleted }, current, undefined)]
  })
  const changes = input.peer.sessions.flatMap((remote): SyncAction[] => {
    const change = sessionChange(remote, local.get(remote.id), deletedHere.get(remote.id))
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
): Change | undefined {
  if (remote.timeArchived !== null) {
    // Archived chats stay local: a peer-archived chat missing here is never pulled.
    if (!current) return
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
        isRecord(tombstone) && typeof tombstone.id === "string" && isFiniteNumber(tombstone.timeDeleted),
    )
  )
}

function isManifestSession(value: unknown): value is ManifestSession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isFiniteNumber(value.timeUpdated) &&
    typeof value.busy === "boolean" &&
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
