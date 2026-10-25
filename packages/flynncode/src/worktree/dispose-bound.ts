import { Effect } from "effect"
import type { Session } from "@/session/session"
import type { Worktree } from "@/worktree"
import { boundSessions } from "./bound-sessions"
import { shouldDispose } from "./session-binding"

// Remove the disposable task worktree a session was bound to once every
// session still bound to it is archived. Shared by archive and delete: a
// deleted session no longer appears among its peers, so `info` must be read
// before removal. The folder is removed only when nothing would be lost (see
// Worktree.disposeIfSafe) and the task branch is always kept. Returns the
// removed worktree directory, or undefined when it was kept.
export const disposeSettledWorktree = Effect.fn("Worktree.disposeSettledWorktree")(function* (input: {
  sessions: Session.Interface
  worktrees: Worktree.Interface
  info: Session.Info
}) {
  const meta = (input.info.metadata ?? {}) as Record<string, unknown>
  if (meta.disposable !== true || typeof meta.worktree !== "string") return undefined
  const peers = yield* boundSessions(input.sessions, meta.worktree)
  const archived = peers.every((peer) => peer.time.archived != null)
  const binding = { sessionID: input.info.id, directory: meta.worktree, disposable: true }
  if (!shouldDispose(binding, { archived, running: false })) return undefined
  const removed = yield* input.worktrees.disposeIfSafe({ directory: meta.worktree })
  return removed ? meta.worktree : undefined
})
