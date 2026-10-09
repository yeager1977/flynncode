export type WorktreeMenuActionKey = "session.worktree.remove" | "session.worktree.reset" | "session.worktree.handoff"

export type WorktreeMenuAction = {
  key: WorktreeMenuActionKey
  disabled: boolean
  disabledReason?: "session.worktree.handoffOccupied"
}

// Menu model for per-worktree actions, shared by the legacy sidebar rows and
// the new-layout session header. Local workspaces only accept handoff (moving
// sessions into main); sandbox worktrees also expose remove and reset.
// Handoff is disabled while busy or when the target already backs an active
// session (occupied guard uses loaded sessions, no new server state).
export function worktreeMenuActions(input: { local: boolean; busy: boolean; occupied: boolean }): WorktreeMenuAction[] {
  const handoff: WorktreeMenuAction = {
    key: "session.worktree.handoff",
    disabled: input.busy || input.occupied,
    ...(input.occupied ? { disabledReason: "session.worktree.handoffOccupied" as const } : {}),
  }
  if (input.local) return [handoff]
  return [
    { key: "session.worktree.remove", disabled: input.busy },
    { key: "session.worktree.reset", disabled: input.busy },
    handoff,
  ]
}
