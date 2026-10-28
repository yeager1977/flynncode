import { Effect, Schema } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./enter-worktree.txt"
import { Session } from "@/session/session"
import { SessionFolderSwitch } from "@/session/folder-switch"
import { Worktree } from "@/worktree"
import { enteredFrom, requireRoot, requireUnswitched, switchError } from "./worktree/guard"

export const Parameters = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({
    description: "Name for the worktree and its branch; defaults to one derived from the session",
  }),
})

type Metadata = { worktree?: { action: "enter"; branch?: string; path: string } }

export const EnterWorktreeTool = Tool.define<
  typeof Parameters,
  Metadata,
  Session.Service | Worktree.Service | SessionFolderSwitch.Service
>(
  "enter_worktree",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const worktrees = yield* Worktree.Service
    const folderSwitch = yield* SessionFolderSwitch.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* requireRoot(sessions, ctx.sessionID)
          const from = enteredFrom(session)
          if (from !== undefined)
            return yield* Effect.fail(
              new Error(
                `This session is already in the worktree ${session.directory} (entered from ${from}); call exit_worktree before entering another`,
              ),
            )
          yield* requireUnswitched(session)
          const info = yield* worktrees
            .makeWorktreeInfo({ name: params.name?.trim() || `session-${ctx.sessionID}` })
            .pipe(Effect.catch((error) => Effect.fail(worktreeError(error))))
          yield* ctx.ask({
            permission: "worktree",
            patterns: [info.branch ?? info.name, info.directory],
            // Entering asks every time: a branch and path are never reused.
            always: [],
            metadata: { action: "enter", branch: info.branch, path: info.directory },
          })
          yield* worktrees.createFromInfo(info).pipe(Effect.catch((error) => Effect.fail(worktreeError(error))))
          const switched = yield* folderSwitch
            .switchPrimary({ sessionID: ctx.sessionID, directory: info.directory })
            .pipe(
              // The session stays put, so the fresh worktree and its branch go again.
              Effect.catch((error) =>
                worktrees
                  .remove({ directory: info.directory })
                  .pipe(
                    Effect.ignore,
                    Effect.andThen(
                      Effect.fail(
                        new Error(`Could not move the session into ${info.directory}: ${switchError(error)}`),
                      ),
                    ),
                  ),
              ),
            )
          // Re-read so the write keeps metadata other writers set meanwhile.
          const latest = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          yield* sessions.setMetadata({
            sessionID: ctx.sessionID,
            // `worktree` + `disposable` is the binding archive/delete disposal reads.
            metadata: {
              ...latest.metadata,
              worktree: info.directory,
              enteredFrom: switched.previous,
              disposable: true,
            },
          })
          return {
            title: `Entered worktree ${info.branch ?? info.name}`,
            metadata: { worktree: { action: "enter" as const, branch: info.branch, path: info.directory } },
            output: [
              `Created worktree ${info.directory} on branch ${info.branch ?? "(detached)"} and moved this session into it.`,
              `Working directory is now ${info.directory}; the previous folder was ${switched.previous}.`,
              "Use exit_worktree to go back, keeping or removing the worktree.",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function worktreeError(error: Worktree.Error) {
  if (error instanceof Worktree.NotGitError)
    return new Error("enter_worktree needs a git repository; this project is not one")
  return new Error(`The worktree could not be created: ${error.message}`)
}
