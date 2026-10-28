export * as SessionRemoval from "./removal"

import { Cause, Effect, Option } from "effect"
import type { FSUtil } from "@flynncode/core/fs-util"
import { SessionProjector } from "@flynncode/core/session/projector"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceStore } from "@/project/instance-store"
import type { Project } from "@/project/project"
import type { Worktree } from "@/worktree"
import { disposeSessionWorktree, disposeSettledWorktree } from "@/worktree/dispose-bound"
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

export type DetachedDeps = Pick<Deps, "sessions" | "worktrees" | "project">

/**
 * The manual delete without loading the session's project, for session retention: removes the session and its
 * descendants (tombstones, events, scheduled jobs, transcripts) and disposes the root's task worktree when nothing
 * would be lost. What needs a loaded instance is skipped: SessionEnd hooks and background-job cancellation (retention
 * never deletes a busy tree), disposal of a worktree whose own instance is loaded (the worktree service refuses it),
 * and keep-N worktree retention (it reads the project config). A worktree left behind stays on the Cleanup page and
 * keep-N retention removes it when the project next creates a worktree. `basis` stamps the tombstones (see
 * `SessionProjector.TombstoneBasis`).
 */
export const removeDetached = Effect.fn("SessionRemoval.removeDetached")(function* (
  deps: DetachedDeps,
  sessionID: SessionID,
  basis?: number,
) {
  const info = yield* deps.sessions.get(sessionID).pipe(Effect.option)
  yield* deps.sessions
    .remove(sessionID)
    .pipe(Effect.provideService(InstanceRef, undefined), Effect.provideService(SessionProjector.TombstoneBasis, basis))
  if (Option.isSome(info))
    yield* disposeDetached(deps, info.value).pipe(
      Effect.catchCause((cause) => Effect.logWarning("worktree disposal failed", { cause: Cause.pretty(cause) })),
    )
})

// The worktree service only checks that the target is not the calling instance's own checkout, so the project's main
// checkout stands in for an instance. Nothing is loaded: the context is never registered with the instance store.
const disposeDetached = Effect.fnUntraced(function* (deps: DetachedDeps, info: Session.Info) {
  const project = yield* deps.project.get(info.projectID)
  if (!project) return
  const removed = yield* disposeSettledWorktree({ sessions: deps.sessions, worktrees: deps.worktrees, info }).pipe(
    Effect.provideService(InstanceRef, {
      directory: project.worktree,
      worktree: project.worktree,
      project,
      additionalDirectories: [],
    }),
  )
  if (removed === undefined) return
  yield* deps.project.removeSandbox(project.id, removed).pipe(Effect.ignore)
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
