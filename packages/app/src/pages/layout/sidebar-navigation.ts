// Keyboard navigation through the sidebar's projects and sessions, shared by
// the classic and new layouts. Lists wrap around; with nothing active, moving
// forward starts at the first item and moving back starts at the last.

export function adjacentIndex(length: number, index: number, offset: number) {
  if (length === 0) return -1
  if (index === -1) return offset > 0 ? 0 : length - 1
  return (index + offset + length) % length
}

export function adjacentProject<T extends { worktree: string }>(projects: T[], active: string | undefined, offset: number) {
  const index = active ? projects.findIndex((project) => project.worktree === active) : -1
  return projects[adjacentIndex(projects.length, index, offset)]
}

export function adjacentSession<T extends { id: string }>(sessions: T[], current: string | undefined, offset: number) {
  const index = adjacentIndex(sessions.length, current ? sessions.findIndex((s) => s.id === current) : -1, offset)
  const session = sessions[index]
  if (!session) return
  return { session, index }
}

export function adjacentUnseenSession<T extends { id: string }>(
  sessions: T[],
  current: string | undefined,
  offset: number,
  unseen: (session: T) => boolean,
) {
  if (!sessions.some(unseen)) return
  const active = current ? sessions.findIndex((s) => s.id === current) : -1
  const start = active === -1 ? (offset > 0 ? -1 : 0) : active
  return Array.from({ length: sessions.length }, (_, i) =>
    offset > 0 ? (start + i + 1) % sessions.length : (start - i - 1 + sessions.length) % sessions.length,
  )
    .map((index) => ({ session: sessions[index], index }))
    .find((item): item is { session: T; index: number } => !!item.session && unseen(item.session))
}
