export * as SessionRemoval from "./removal"

import { Cause, Effect, Option } from "effect"
import type { FSUtil } from "@flynncode/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceStore } from "@/project/instance-store"
import type { Project } from "@/project/project"
import type { Worktree } from "@/worktree"
import { disposeSessionWorktree } from "@/worktree/dispose-bound"
import type { SessionID } from "./schema"
import type { Session } from "./session"
import type { SessionStatus } from "./status"

export type Deps = {
  sessions: Session.Interface
  worktrees: Worktree.Interface
  store: InstanceStore.Interface
  status: SessionStatus.Interface
  fs: FSUtil.Interface
  project: Project.Interface
}

/**
 * The manual delete, shared by `DELETE /session/{id}` and session retention: removes the session and its descendants
 * (tombstones, events, scheduled jobs, transcripts), then disposes the session's worktree binding when nothing would
 * be lost. Runs inside the instance the disposal works from.
 */
export const remove = Effect.fn("SessionRemoval.remove")(function* (deps: Deps, sessionID: SessionID) {
  // Read before removal: the binding lives in the session's metadata. Tolerate unreadable (broken) sessions; remove
  // must still work for them.
  const info = yield* deps.sessions.get(sessionID).pipe(Effect.option)
  yield* deps.sessions.remove(sessionID)
  // catchCause, not ignore: a defect in disposal must not fail the completed delete.
  if (Option.isSome(info))
    yield* disposeWorktree(deps, info.value).pipe(
      Effect.catchCause((cause) => Effect.logWarning("worktree disposal failed", { cause: Cause.pretty(cause) })),
    )
})

/**
 * Dispose-on-archive/delete: a session carrying a disposable worktree binding in its metadata removes that worktree's
 * folder once every session bound to it is archived (or gone), no loaded instance runs there, and nothing would be
 * lost (clean, every commit reachable from another ref). The task branch is kept; a kept worktree shows on the Cleanup
 * page. Best-effort: callers already archived or deleted the session.
 */
export const disposeWorktree = Effect.fn("SessionRemoval.disposeWorktree")(function* (deps: Deps, info: Session.Info) {
  const removed = yield* disposeSessionWorktree({
    sessions: deps.sessions,
    worktrees: deps.worktrees,
    store: deps.store,
    status: deps.status,
    fs: deps.fs,
    info,
  })
  if (removed === undefined) return
  const inst = yield* InstanceState.context
  yield* deps.project.removeSandbox(inst.project.id, removed).pipe(Effect.ignore)
  // Keep-N retention also runs when sessions archive, not only on worktree creation; best-effort like the dispose.
  yield* deps.worktrees.retire.pipe(Effect.ignore)
})
