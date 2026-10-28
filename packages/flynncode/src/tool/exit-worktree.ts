import { Cause, Effect, Schedule, Schema, Scope } from "effect"
import { FSUtil } from "@flynncode/core/fs-util"
import { Tool } from "./tool"
import DESCRIPTION from "./exit-worktree.txt"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionFolderSwitch } from "@/session/folder-switch"
import { SessionStatus } from "@/session/status"
import { Worktree } from "@/worktree"
import { enteredFrom, requireRoot, requireUnswitched, switchError } from "./worktree/guard"

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
  | InstanceStore.Service
  | SessionStatus.Service
  | Project.Service
  | Scope.Scope
>(
  "exit_worktree",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const worktrees = yield* Worktree.Service
    const folderSwitch = yield* SessionFolderSwitch.Service
    const store = yield* InstanceStore.Service
    const status = yield* SessionStatus.Service
    const project = yield* Project.Service
    const scope = yield* Scope.Scope

    // Whether a session runs in the worktree's instance. Disposing that
    // instance cancels its runs, which includes this turn when it started
    // inside the worktree.
    const inUse = (directory: string) =>
      Effect.gen(function* () {
        if (!(yield* store.loadedDirectories()).has(FSUtil.resolve(directory))) return false
        return (yield* store.provide({ directory }, status.list())).size > 0
      })

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
          const worktree =
            typeof session.metadata?.worktree === "string" ? session.metadata.worktree : session.directory
          const instance = yield* InstanceState.context
          const branch = (yield* worktrees.list().pipe(Effect.orElseSucceed(() => []))).find(
            (entry) => entry.directory === FSUtil.resolve(worktree),
          )?.branch
          const label = branch ? `${worktree} (branch ${branch})` : worktree
          const remove = params.action === "remove"
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
              permission: "worktree",
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

          const forced = loss.length > 0
          // Worktree removal runs in the instance of the folder the session is back in:
          // the worktree service never removes the worktree of the instance it runs in.
          const removal = store.provide(
            { directory: moved.next },
            Effect.gen(function* () {
              yield* store.disposeDirectory(worktree)
              const removed = forced
                ? yield* worktrees.remove({ directory: worktree })
                : yield* worktrees.disposeIfSafe({ directory: worktree })
              if (removed) yield* project.removeSandbox(instance.project.id, worktree).pipe(Effect.ignore)
              return removed
            }),
          )
          const busy = remove && (yield* inUse(worktree))
          if (busy)
            yield* inUse(worktree).pipe(
              Effect.repeat({ schedule: Schedule.spaced("1 second"), while: (running) => running }),
              Effect.andThen(removal),
              Effect.catchCause((cause) =>
                Effect.logWarning("deferred worktree removal failed", { worktree, cause: Cause.pretty(cause) }),
              ),
              Effect.forkIn(scope),
            )
          const outcome =
            remove && !busy ? yield* removal.pipe(Effect.catch((error) => Effect.succeed(error.message))) : undefined
          const removed = outcome === true

          const back = moved.fallback
            ? `${from} no longer exists, so the session moved to the project's main folder ${moved.next}.`
            : `Working directory is now ${moved.next}.`
          const fate = !remove
            ? `The worktree ${label} was kept.`
            : busy
              ? `The worktree ${label} is still in use by this turn, so it is removed once the turn ends${forced ? "" : ", if nothing would be lost by then"}.`
              : removed
                ? forced
                  ? `Discarded the worktree ${label} and its branch.`
                  : `Removed the worktree ${worktree}${branch ? `; branch ${branch} was kept` : ""}.`
                : typeof outcome === "string"
                  ? `Removing the worktree failed (${outcome}); ${label} was kept.`
                  : `The worktree ${label} was kept: it changed since the check or is still open elsewhere.`
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
        }).pipe(Effect.orDie),
    }
  }),
)
