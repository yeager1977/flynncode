import { Effect, Schema } from "effect"
import { FSUtil } from "@flynncode/core/fs-util"
import { Tool } from "./tool"
import DESCRIPTION from "./exit-worktree.txt"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionFolderSwitch } from "@/session/folder-switch"
import { SessionRunState } from "@/session/run-state"
import { Worktree } from "@/worktree"
import { WorktreeRemoval } from "@/worktree/removal"
import { enteredFrom, oncePerStep, requireRoot, requireUnswitched, switchError } from "./worktree/guard"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["keep", "remove"]).annotate({
    description: "keep leaves the worktree and its branch on disk; remove deletes the worktree folder",
  }),
  discard_changes: Schema.optional(Schema.Boolean).annotate({
    description:
      "With remove: delete the worktree and its branch even when uncommitted changes or unmerged commits would be lost (asks the user first)",
  }),
})

type Metadata = {
  worktree?: { action: "exit"; path: string; from: string; removed: boolean; pending?: true }
}

// Session metadata the enter_worktree binding consists of.
const BINDING = ["worktree", "enteredFrom", "disposable"]

export const ExitWorktreeTool = Tool.define<
  typeof Parameters,
  Metadata,
  | Session.Service
  | Worktree.Service
  | SessionFolderSwitch.Service
  | WorktreeRemoval.Service
  | SessionRunState.Service
  | FSUtil.Service
>(
  "exit_worktree",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const worktrees = yield* Worktree.Service
    const folderSwitch = yield* SessionFolderSwitch.Service
    const removals = yield* WorktreeRemoval.Service
    const runState = yield* SessionRunState.Service
    const fsys = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* requireRoot(sessions, ctx.sessionID)
          const from = enteredFrom(session)
          if (from === undefined)
            return yield* Effect.fail(
              new Error(
                "exit_worktree only leaves a worktree entered with enter_worktree, and this session has not entered one; nothing changed",
              ),
            )
          yield* requireUnswitched(session)
          const remove = params.action === "remove"
          const recorded = session.metadata?.worktree
          // Removal deletes only the worktree the session recorded entering,
          // never a folder guessed from where the session happens to be.
          if (remove && typeof recorded !== "string")
            return yield* Effect.fail(
              new Error(
                "Not removed: this session does not record which worktree it entered, so nothing is deleted. Exit with action keep; the worktree can be removed from the Cleanup page.",
              ),
            )
          const worktree = typeof recorded === "string" ? recorded : session.directory
          const instance = yield* InstanceState.context
          const listed = (yield* worktrees.list().pipe(Effect.orElseSucceed(() => []))).find(
            (entry) => entry.directory === FSUtil.resolve(worktree),
          )
          if (remove && listed === undefined && (yield* fsys.existsSafe(worktree)))
            return yield* Effect.fail(
              new Error(
                `Not removed: ${worktree} is not a registered worktree of this project, so nothing is deleted. Exit with action keep.`,
              ),
            )
          const branch = listed?.branch
          const label = branch ? `${worktree} (branch ${branch})` : worktree
          const loss = remove ? yield* worktrees.losses({ directory: worktree }) : []
          if (loss.length > 0 && params.discard_changes !== true)
            return yield* Effect.fail(
              new Error(
                [
                  `Not removed: removing ${label} would lose ${loss.join("; ")}.`,
                  "The session is still in the worktree. Commit and merge or push the work first, exit with action keep, or pass discard_changes: true to discard it.",
                ].join("\n"),
              ),
            )
          if (loss.length > 0)
            yield* ctx.ask({
              // Its own key, asked in every approval mode (Permission.ALWAYS_ASK):
              // allowing worktree entry never allows discarding work.
              permission: "worktree_discard",
              patterns: [`discard ${label}: ${loss.join("; ")}`],
              // A loss is approved one at a time.
              always: [],
              metadata: { action: "discard", path: worktree, branch, loss },
            })

          const main = instance.project.worktree
          const moved = yield* folderSwitch.switchPrimary({ sessionID: ctx.sessionID, directory: from }).pipe(
            Effect.map((result) => ({ ...result, fallback: false })),
            Effect.catchTag("SessionFolderNotFoundError", (error) =>
              error.folder === from && main !== worktree
                ? folderSwitch
                    .switchPrimary({ sessionID: ctx.sessionID, directory: main })
                    .pipe(Effect.map((result) => ({ ...result, fallback: true })))
                : Effect.fail(error),
            ),
            Effect.catch((error) =>
              Effect.fail(new Error(`Could not move the session out of ${worktree}: ${switchError(error)}`)),
            ),
          )
          const latest = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          yield* sessions.setMetadata({
            sessionID: ctx.sessionID,
            metadata: Object.fromEntries(
              Object.entries(latest.metadata ?? {}).filter(([key]) => !BINDING.includes(key)),
            ),
          })

          const request = {
            path: worktree,
            home: moved.next,
            main,
            forced: loss.length > 0,
            loss,
          }
          // During a turn the worktree's instance is busy: the removal waits,
          // recorded on the session, until nothing runs there.
          const busy = remove && (yield* removals.inUse(worktree))
          if (busy) yield* removals.defer(ctx.sessionID, { ...request, messageID: ctx.messageID, callID: ctx.callID })
          const outcome = remove && !busy ? yield* removals.run(request) : undefined
          const removed = outcome?.removed === true
          const forced = request.forced

          const back = moved.fallback
            ? `${from} no longer exists, so the session moved to the project's main folder ${moved.next}.`
            : `Working directory is now ${moved.next}.`
          const fate = !remove
            ? `The worktree ${label} was kept.`
            : busy
              ? `The worktree ${label} is still in use, so it is removed once nothing runs in it any more${forced ? "" : ", if nothing would be lost by then"}.`
              : removed
                ? forced
                  ? `Discarded the worktree ${label} and its branch.`
                  : `Removed the worktree ${worktree}${branch ? `; branch ${branch} was kept` : ""}.`
                : `The worktree ${label} was kept: ${outcome?.reason ?? "it changed since the check or is still open elsewhere"}.`
          return {
            title: `Left worktree ${branch ?? worktree}`,
            metadata: {
              worktree: {
                action: "exit" as const,
                path: moved.next,
                from: worktree,
                removed,
                ...(busy ? { pending: true as const } : {}),
              },
            },
            output: [back, fate].join("\n"),
          }
        }).pipe(oncePerStep(runState, ctx), Effect.orDie),
    }
  }),
)
