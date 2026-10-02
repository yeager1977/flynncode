import type { Session } from "@opencode-ai/sdk/v2/client"

const DAY = 86_400_000

export const BULK_PRESETS = [
  { id: "1w", days: 7 },
  { id: "2w", days: 14 },
  { id: "1m", days: 30 },
  { id: "3m", days: 90 },
  { id: "6m", days: 180 },
  { id: "1y", days: 365 },
] as const

export type BulkPreset = (typeof BULK_PRESETS)[number]["id"]

export type ProtectionInput = {
  openRouteID?: string
  openTabIDs: ReadonlySet<string>
  working: (id: string) => boolean
  pending: (id: string) => boolean
  parentID?: ReadonlyMap<string, string | undefined>
}

export type RangeInput = {
  order: readonly string[]
  selected: readonly string[]
  anchor: string | undefined
  id: string
  allowed: ReadonlySet<string>
}

export function presetDays(id: BulkPreset) {
  const preset = BULK_PRESETS.find((item) => item.id === id)
  if (!preset) return 7
  return preset.days
}

export function sessionTimestamp(session: Session) {
  return session.time.updated ?? session.time.created
}

export function isOlderThan(session: Session, now: number, days: number) {
  return sessionTimestamp(session) < now - days * DAY
}

export function eligibleRoots(sessions: readonly Session[]) {
  return sessions.filter((session) => !session.parentID && session.time.archived === undefined)
}

export function parentLinks(ids: Iterable<string>, parentOf: (id: string) => string | undefined) {
  const links = new Map<string, string | undefined>()
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    const parentID = parentOf(id)
    links.set(id, parentID)
    if (!parentID) return
    visit(parentID)
  }
  for (const id of ids) visit(id)
  return links
}

export function protectedRootIDs(sessions: readonly Session[], input: ProtectionInput) {
  const parentOf = new Map<string, string | undefined>()
  for (const [id, parentID] of input.parentID ?? []) parentOf.set(id, parentID)
  for (const session of sessions) parentOf.set(session.id, session.parentID)

  const blocked = new Set<string>()
  if (input.openRouteID) blocked.add(input.openRouteID)
  for (const id of input.openTabIDs) blocked.add(id)
  for (const id of parentOf.keys()) {
    if (input.working(id) || input.pending(id)) blocked.add(id)
  }
  for (const id of [...blocked]) {
    const seen = new Set<string>([id])
    let parentID = parentOf.get(id)
    while (parentID && !seen.has(parentID)) {
      blocked.add(parentID)
      seen.add(parentID)
      parentID = parentOf.get(parentID)
    }
  }
  return blocked
}

export function cleanupCandidates(
  sessions: readonly Session[],
  now: number,
  days: number,
  blocked: ReadonlySet<string>,
) {
  const match: Session[] = []
  const skipped: Session[] = []
  for (const session of eligibleRoots(sessions)) {
    if (!isOlderThan(session, now, days)) continue
    if (blocked.has(session.id)) {
      skipped.push(session)
      continue
    }
    match.push(session)
  }
  return { match, skipped }
}

export function toggleID(selected: readonly string[], id: string, allowed: ReadonlySet<string>) {
  if (!allowed.has(id)) return [...selected]
  if (selected.includes(id)) return selected.filter((item) => item !== id)
  return [...selected, id]
}

export function selectRange(input: RangeInput) {
  if (!input.allowed.has(input.id)) return { selected: [...input.selected], anchor: input.anchor }
  if (!input.anchor) return { selected: toggleID([], input.id, input.allowed), anchor: input.id }
  const start = input.order.indexOf(input.anchor)
  const end = input.order.indexOf(input.id)
  if (start === -1 || end === -1)
    return { selected: toggleID(input.selected, input.id, input.allowed), anchor: input.id }
  const [from, to] = start < end ? [start, end] : [end, start]
  const next = new Set(input.selected)
  for (const id of input.order.slice(from, to + 1)) {
    if (input.allowed.has(id)) next.add(id)
  }
  return { selected: [...next], anchor: input.anchor }
}

export function selectLoaded(order: readonly string[], allowed: ReadonlySet<string>) {
  return order.filter((id) => allowed.has(id))
}

export function confirmIDs(
  selected: readonly string[],
  loaded: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  blocked: ReadonlySet<string> = new Set(),
) {
  return selected.filter((id) => !blocked.has(id) && (!loaded.has(id) || allowed.has(id)))
}
