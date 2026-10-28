import { Effect } from "effect"
import { FSUtil } from "@flynncode/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import type { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionFolderSwitch } from "@/session/folder-switch"
import type { SessionRunState } from "@/session/run-state"

export const NOT_ROOT = "worktree tools are only available in the main session, not in sub-agents"
export const ALREADY_SWITCHED =
  "the session's working directory already changed in this step; call the tool again in the next step"

export const requireRoot = Effect.fnUntraced(function* (sessions: Session.Interface, sessionID: SessionID) {
  const info = yield* sessions.get(sessionID).pipe(Effect.orDie)
  if (info.parentID !== undefined) return yield* Effect.fail(new Error(NOT_ROOT))
  return info
})

// A step runs in the instance of the folder it started in, and the prompt loop
// moves to a new primary folder only after the step, so a session whose folder
// no longer matches its instance already switched in this step.
export const requireUnswitched = Effect.fnUntraced(function* (info: Session.Info) {
  const instance = yield* InstanceState.context
  if (FSUtil.resolve(info.directory) !== FSUtil.resolve(instance.directory))
    return yield* Effect.fail(new Error(ALREADY_SWITCHED))
})

// Runs a folder switch as the only one of its step: the step is claimed in
// the session's run state before anything else can yield, and a failed
// switch gives it back.
export const oncePerStep =
  (runState: SessionRunState.Interface, ctx: { sessionID: SessionID; messageID: MessageID }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Error, R> =>
    Effect.gen(function* () {
      if (!(yield* runState.claimStep(ctx.sessionID, ctx.messageID))) return yield* Effect.fail(new Error(ALREADY_SWITCHED))
      return yield* effect.pipe(Effect.onError(() => runState.releaseStep(ctx.sessionID, ctx.messageID)))
    })

// The folder an enter_worktree call left, set only while the session is in that worktree.
export function enteredFrom(info: Session.Info) {
  const value = info.metadata?.enteredFrom
  return typeof value === "string" ? value : undefined
}

export function switchError(error: SessionFolderSwitch.Error) {
  if (error._tag === "SessionFolderNotFoundError") return `${error.folder} does not exist`
  if (error._tag === "SessionFolderProjectMismatchError") return `${error.folder} belongs to another project`
  if (error._tag === "SessionFolderBusyError") return "the session is running a turn"
  return `the session would have ${error.count} extra folders, more than allowed`
}
