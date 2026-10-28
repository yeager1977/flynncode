import { Effect } from "effect"
import { FSUtil } from "@flynncode/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceStore } from "@/project/instance-store"
import type { Session } from "@/session/session"
import type { SessionStatus } from "@/session/status"
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

// The archive/delete disposal of a session's worktree. A session inside a
// worktree it entered with enter_worktree runs in that worktree's own
// instance, which the worktree service never removes while loaded: the
// instance is unloaded once nothing runs in it, and the disposal runs from the
// folder the session entered it from (the project's main folder when that is
// gone).
export const disposeSessionWorktree = Effect.fn("Worktree.disposeSessionWorktree")(function* (input: {
  sessions: Session.Interface
  worktrees: Worktree.Interface
  store: InstanceStore.Interface
  status: SessionStatus.Interface
  fs: FSUtil.Interface
  info: Session.Info
}) {
  const worktree = input.info.metadata?.worktree
  const from = input.info.metadata?.enteredFrom
  if (typeof worktree !== "string" || typeof from !== "string") return yield* disposeSettledWorktree(input)
  const loaded = (yield* input.store.loadedDirectories()).has(FSUtil.resolve(worktree))
  if (loaded && (yield* input.store.provide({ directory: worktree }, input.status.list())).size > 0) return undefined
  if (loaded) yield* input.store.disposeDirectory(worktree)
  const ctx = yield* InstanceState.context
  const home = (yield* input.fs.existsSafe(from)) ? from : ctx.project.worktree
  return yield* input.store.provide({ directory: home }, disposeSettledWorktree(input))
})
