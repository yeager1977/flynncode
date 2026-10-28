export type ManifestSession = {
  id: string
  parentID: string | null
  timeUpdated: number
  timeArchived: number | null
  busy: boolean
  /** Session retention never deletes this session's tree: it is kept, or a schedule hold protects it. Syncs. */
  kept?: boolean
  /**
   * A scheduled job in this machine's own database. A retention tombstone never deletes this machine's copy of the
   * tree, but the flag is no evidence for other machines: only the hold it leads to travels.
   */
  scheduled?: boolean
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
  const fates = retention([input.local, input.peer])
  // A retention tombstone whose tree survives is void on both sides; `voids` names the roots the worker drops here.
  const holds = (tombstone: Tombstone) => tombstone.root === undefined || fates.get(tombstone.root)?.survives !== true
  const local = new Map(input.local.sessions.map((session) => [session.id, session]))
  const peer = new Map(input.peer.sessions.map((session) => [session.id, session]))
  const deletedHere = new Map(input.local.tombstones.filter(holds).map((tombstone) => [tombstone.id, tombstone]))
  // The deleting machine takes back every member of a tree that survived its retention delete, archived ones included.
  const restored = new Set(
    input.local.tombstones.filter((tombstone) => !holds(tombstone)).map((tombstone) => tombstone.id),
  )

  const deletes = input.peer.tombstones.filter(holds).flatMap((tombstone): SyncAction[] => {
    const current = local.get(tombstone.id)
    if (!current) return []
    if (tombstone.root === undefined) {
      if (tombstone.timeDeleted <= current.timeUpdated) return []
      return [guard({ type: "delete", id: tombstone.id, timeDeleted: tombstone.timeDeleted }, current, undefined)]
    }
    // A member of a tree running here waits like a running session.
    return [
      guard(
        { type: "delete", id: tombstone.id, timeDeleted: tombstone.timeDeleted, root: tombstone.root },
        { ...current, busy: fates.get(tombstone.root)?.busy ?? current.busy },
        undefined,
      ),
    ]
  })

  const decided = new Map<string, Change | undefined>()
  const changeOf = (remote: ManifestSession, seen: Set<string>): Change | undefined => {
    if (decided.has(remote.id)) return decided.get(remote.id)
    seen.add(remote.id)
    // An archived chat travels with its tree: its parent is here, or comes in this cycle.
    const attached = () => {
      if (restored.has(remote.id)) return true
      if (remote.parentID === null) return false
      if (local.has(remote.parentID)) return true
      const parent = peer.get(remote.parentID)
      return parent !== undefined && !seen.has(parent.id) && changeOf(parent, seen)?.type === "pull"
    }
    const change = sessionChange(remote, local.get(remote.id), deletedHere.get(remote.id)?.timeDeleted, attached)
    decided.set(remote.id, change)
    return change
  }
  const changes = input.peer.sessions.flatMap((remote): SyncAction[] => {
    const change = changeOf(remote, new Set())
    return change ? [guard(change, local.get(remote.id), remote)] : []
  })
  const pulls = parentsFirst(
    changes.filter((action): action is { type: "pull"; id: string } => action.type === "pull"),
    peer,
  )
  return [...deletes, ...pulls, ...changes.filter((action) => action.type !== "pull")]
}

/**
 * The roots whose retention tombstones this machine drops for good: on some side their tree is newer than the
 * deletion's basis, kept, held by a job here, or a side lacks one of its members. Survival is sticky: once dropped,
 * nothing here deletes those members again for that deletion.
 */
export function voids(input: { local: Manifest; peer: Manifest }) {
  const fates = retention([input.local, input.peer])
  const roots = input.local.tombstones.flatMap((tombstone) => (tombstone.root === undefined ? [] : [tombstone.root]))
  return [...new Set(roots)].filter((root) => fates.get(root)?.survives === true)
}

function sessionChange(
  remote: ManifestSession,
  current: ManifestSession | undefined,
  deletedAt: number | undefined,
  attached: () => boolean,
): Change | undefined {
  if (!current) {
    if (deletedAt !== undefined && deletedAt >= remote.timeUpdated) return
    // Archived chats stay local: a peer-archived chat missing here is pulled only with its tree.
    if (remote.timeArchived !== null && !attached()) return
    return { type: "pull", id: remote.id }
  }
  if (remote.timeArchived !== null) {
    // Newer peer content wins; the bundle carries time_archived, so pulling archives it too.
    if (remote.timeUpdated > current.timeUpdated) return { type: "pull", id: remote.id }
    if (current.timeArchived !== null) return
    if (remote.timeArchived <= current.timeUpdated) return
    return { type: "archive", id: remote.id, timeArchived: remote.timeArchived }
  }
  if (current.timeArchived !== null)
    return remote.timeUpdated > current.timeArchived ? { type: "pull", id: remote.id } : undefined
  return remote.timeUpdated > current.timeUpdated ? { type: "pull", id: remote.id } : undefined
}

type Fate = {
  /** The oldest basis among the tree's retention tombstones on either side. */
  basis: number
  /** The tree's sessions on each side, in manifest order: [first side, second side]. */
  members: ManifestSession[][]
  /** Ids each side has as a session or a tombstone of any kind. */
  known: Array<Set<string>>
  /** Whether a side has evidence every machine can see: a member kept, or written at or after `basis`. */
  evident: boolean[]
  /** The tree survives every retention tombstone that names it, on every machine. */
  survives: boolean
  /** A member of the tree runs on the first side. */
  busy: boolean
}

/**
 * Judges every retention deletion by tree, across both sides. A deletion's tree is every session that either side has
 * under the root its tombstones name, or under a member one of those tombstones covers (a side that lacks a middle
 * session still places the sessions below it). The tree survives when, on either side, a member is kept or held, has
 * activity at or after the basis (the deleter's newest activity plus 1 ms, so activity it never saw), or a side that
 * holds the tree lacks a member the other side knows: an unknown member counts as one the deleter never judged.
 * A surviving tree keeps every member on every machine.
 */
function retention(sides: Manifest[]) {
  const rooted = sides
    .flatMap((side) => side.tombstones)
    .flatMap((tombstone) => (tombstone.root === undefined ? [] : [{ ...tombstone, root: tombstone.root }]))
  const named = new Map(rooted.map((tombstone) => [tombstone.id, tombstone.root]))
  const roots = Map.groupBy(rooted, (tombstone) => tombstone.root)
  const name = (id: string) => named.get(id) ?? (roots.has(id) ? id : undefined)
  const views = sides.map((side) => {
    const rootOf = treeRoot(side.sessions, name)
    return {
      members: Map.groupBy(
        side.sessions.flatMap((session) => {
          const root = rootOf(session.id)
          return root === undefined ? [] : [{ root, session }]
        }),
        (item) => item.root,
      ),
      known: new Set([...side.sessions.map((session) => session.id), ...side.tombstones.map((item) => item.id)]),
      deleted: new Set(side.tombstones.flatMap((tombstone) => (tombstone.root === undefined ? [] : [tombstone.root]))),
    }
  })
  return new Map(
    [...roots].map(([root, tombstones]): [string, Fate] => {
      const basis = Math.min(...tombstones.map((tombstone) => tombstone.timeDeleted))
      const members = views.map((view) => (view.members.get(root) ?? []).map((item) => item.session))
      const evident = members.map((list) =>
        list.some((session) => session.kept === true || session.timeUpdated >= basis),
      )
      const ids = new Set([
        ...members.flat().map((session) => session.id),
        ...tombstones.map((tombstone) => tombstone.id),
      ])
      const lacks = views.some(
        (view, index) =>
          (members[index]!.length > 0 || view.deleted.has(root)) && [...ids].some((id) => !view.known.has(id)),
      )
      const scheduled = members.flat().some((session) => session.scheduled === true)
      return [
        root,
        {
          basis,
          members,
          known: views.map((view) => view.known),
          evident,
          survives: evident.some(Boolean) || lacks || scheduled,
          busy: members[0]!.some((session) => session.busy),
        },
      ]
    }),
  )
}

/**
 * The retention root a session's tree answers to on one side: the name of its topmost ancestor present there, or of
 * that top's missing parent. Undefined for a session no retention tombstone reaches.
 */
function treeRoot(sessions: ManifestSession[], name: (id: string) => string | undefined) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  // A hostile peer manifest may contain parent cycles; stop at the first repeat.
  const top = (id: string, seen = new Set<string>()): string => {
    const parentID = byID.get(id)?.parentID
    if (!parentID || !byID.has(parentID) || seen.has(parentID)) return id
    return top(parentID, seen.add(id))
  }
  return (id: string) => {
    const head = byID.get(top(id))
    if (!head) return undefined
    return name(head.id) ?? (head.parentID === null ? undefined : name(head.parentID))
  }
}

function guard(change: Change, current: ManifestSession | undefined, remote: ManifestSession | undefined): SyncAction {
  if (current?.busy) return { type: "skip", id: change.id, reason: "local-busy" }
  if (remote?.busy) return { type: "skip", id: change.id, reason: "peer-busy" }
  return change
}

function parentsFirst<T extends { id: string }>(items: T[], parents: Map<string, { parentID: string | null }>) {
  const pending = new Map(items.map((item) => [item.id, item]))
  const ordered: T[] = []
  const visit = (id: string, seen: Set<string>) => {
    const item = pending.get(id)
    if (!item || seen.has(id)) return
    seen.add(id)
    const parentID = parents.get(id)?.parentID
    if (parentID) visit(parentID, seen)
    pending.delete(id)
    ordered.push(item)
  }
  items.forEach((item) => visit(item.id, new Set()))
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
    (value.scheduled === undefined || typeof value.scheduled === "boolean") &&
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
  /**
   * `tree`: the push returns a member of a tree that survived a retention delete the hub still holds. Such pushes are
   * never held back by the batch, and the evidence (a member written since the deletion, kept, or unknown to the
   * deleter) goes first: without it on the hub, the deleting machine would delete the other members again. `evidence`
   * marks those; the rest of the tree waits for the next cycle unless they all reached the hub and the hub dropped
   * the deletion.
   */
  | { type: "push"; id: string; tree?: string; evidence?: true }
  | { type: "delete"; id: string; timeDeleted: number; root?: string }
  | { type: "archive"; id: string; timeArchived: number }
  | { type: "skip"; id: string; reason: "local-busy" | "peer-busy" }

export function decidePush(input: { local: Manifest; hub: Manifest }): PushAction[] {
  const fates = retention([input.local, input.hub])
  const local = new Map(input.local.sessions.map((session) => [session.id, session]))
  const hub = new Map(input.hub.sessions.map((session) => [session.id, session]))
  const hubDeleted = new Set(
    input.hub.tombstones.flatMap((tombstone) => (tombstone.root === undefined ? [] : [tombstone.root])),
  )
  // Surviving trees the hub still holds retention tombstones for, by member: they go back to the hub first.
  const returning = new Map(
    [...fates]
      .filter(([root, fate]) => fate.survives && hubDeleted.has(root))
      .flatMap(([root, fate]) => fate.members[0]!.map((session): [string, string] => [session.id, root])),
  )

  const pushed = new Map<string, PushAction | undefined>()
  const pushOf = (current: ManifestSession, seen: Set<string>): PushAction | undefined => {
    if (pushed.has(current.id)) return pushed.get(current.id)
    seen.add(current.id)
    const remote = hub.get(current.id)
    // An archived chat travels with its tree: its parent is on the hub, or goes there in this cycle.
    const attached = () => {
      if (current.parentID === null) return false
      if (hub.has(current.parentID)) return true
      const parent = local.get(current.parentID)
      return parent !== undefined && !seen.has(parent.id) && pushOf(parent, seen)?.type === "push"
    }
    const action = ((): PushAction | undefined => {
      if (remote?.busy) return { type: "skip", id: current.id, reason: "peer-busy" }
      if (current.busy) return { type: "skip", id: current.id, reason: "local-busy" }
      if (remote) return current.timeUpdated > remote.timeUpdated ? { type: "push", id: current.id } : undefined
      if (current.timeArchived !== null && !returning.has(current.id) && !attached()) return undefined
      return { type: "push", id: current.id }
    })()
    pushed.set(current.id, action)
    return action
  }
  const actions = input.local.sessions.flatMap((current) => {
    const action = pushOf(current, new Set())
    return action ? [action] : []
  })

  const trees = [...new Set(returning.values())].flatMap((root) =>
    returnTree({ root, fate: fates.get(root)!, actions, local, hub }),
  )
  const deletes = input.local.tombstones.flatMap((tombstone): PushAction[] => {
    const remote = hub.get(tombstone.id)
    if (!remote) return []
    if (tombstone.root === undefined)
      return tombstone.timeDeleted > remote.timeUpdated
        ? [{ type: "delete", id: tombstone.id, timeDeleted: tombstone.timeDeleted }]
        : []
    // A retention delete reaches the hub only while its tree survives nowhere; see `retention`.
    if (fates.get(tombstone.root)?.survives === true) return []
    return [{ type: "delete", id: tombstone.id, timeDeleted: tombstone.timeDeleted, root: tombstone.root }]
  })
  return [...trees, ...actions.filter((action) => !returning.has(action.id)), ...deletes]
}

/**
 * The pushes that return one surviving tree to the hub. When the hub itself shows the tree newer or kept, every member
 * just goes back. Otherwise the evidence goes first: the members written since the deletion's basis, kept, or unknown
 * to the deleter. Once one of them is on the hub, the hub drops the whole deletion, and the deleting machine sees the
 * tree survive (a member there joins its tree through its own or its parent's tombstone, so it needs no ancestors).
 * The rest of the tree follows once the hub shows the deletion gone. With no evidence to send (the tree survives here
 * only for a local job), or while a piece of evidence is running, members the hub lacks stay here: the deleting
 * machine would only delete them again.
 */
function returnTree(input: {
  root: string
  fate: Fate
  actions: PushAction[]
  local: Map<string, ManifestSession>
  hub: Map<string, ManifestSession>
}): PushAction[] {
  const fate = input.fate
  const members = new Set(fate.members[0]!.map((session) => session.id))
  const own = input.actions.filter((action) => members.has(action.id))
  const skips = own.filter((action) => action.type === "skip")
  const pushes = parentsFirst(
    own.filter((action) => action.type === "push"),
    input.local,
  )
  if (fate.evident[1]) return [...skips, ...pushes.map((action) => ({ ...action, tree: input.root }))]
  const evidence = new Set(
    fate.members[0]!.filter(
      (session) => session.kept === true || session.timeUpdated >= fate.basis || !fate.known[1]!.has(session.id),
    ).map((session) => session.id),
  )
  if (evidence.size === 0 || skips.some((action) => evidence.has(action.id)))
    return [...skips, ...pushes.filter((action) => input.hub.has(action.id))]
  return [
    ...skips,
    ...pushes
      .filter((action) => evidence.has(action.id))
      .map((action) => ({ ...action, tree: input.root, evidence: true as const })),
    ...pushes.filter((action) => !evidence.has(action.id)).map((action) => ({ ...action, tree: input.root })),
  ]
}
