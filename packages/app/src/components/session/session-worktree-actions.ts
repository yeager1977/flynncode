export type WorktreeMenuActionKey = "session.worktree.remove" | "session.worktree.reset" | "session.worktree.handoff"

export type WorktreeMenuAction = {
  key: WorktreeMenuActionKey
  disabled: boolean
  disabledReason?: "session.worktree.handoffOccupied" | "session.worktree.handoffNoTab"
}

// Menu model for per-worktree actions, shared by the legacy sidebar rows and
// the new-layout session header. Local workspaces only accept handoff (moving
// sessions into main); sandbox worktrees also expose remove and reset.
// Handoff is disabled while busy, when the target already backs an active
// session (occupied guard uses loaded sessions, no new server state), or when
// there is no open session or draft to hand off from (`routed: false`).
export function worktreeMenuActions(input: {
  local: boolean
  busy: boolean
  occupied: boolean
  routed?: boolean
}): WorktreeMenuAction[] {
  const reason =
    input.routed === false
      ? ("session.worktree.handoffNoTab" as const)
      : input.occupied
        ? ("session.worktree.handoffOccupied" as const)
        : undefined
  const handoff: WorktreeMenuAction = {
    key: "session.worktree.handoff",
    disabled: input.busy || input.occupied || input.routed === false,
    ...(reason ? { disabledReason: reason } : {}),
  }
  if (input.local) return [handoff]
  return [
    { key: "session.worktree.remove", disabled: input.busy },
    { key: "session.worktree.reset", disabled: input.busy },
    handoff,
  ]
}
