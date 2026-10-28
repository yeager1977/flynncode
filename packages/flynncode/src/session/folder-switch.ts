export * as SessionFolderSwitch from "./folder-switch"

import { LayerNode } from "@flynncode/core/effect/layer-node"
import { FSUtil } from "@flynncode/core/fs-util"
import { ProjectV2 } from "@flynncode/core/project"
import { ProjectDirectories } from "@flynncode/core/project/directories"
import { MaxExtras, normalizeFolders } from "@flynncode/core/project/folders"
import { AbsolutePath } from "@flynncode/core/schema"
import { SessionFolders } from "@flynncode/core/session/folders"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceStore } from "@/project/instance-store"
import type { SessionID } from "./schema"
import { Session } from "./session"

export class FolderNotFoundError extends Schema.TaggedErrorClass<FolderNotFoundError>()("SessionFolderNotFoundError", {
  folder: Schema.String,
}) {}

export class ProjectMismatchError extends Schema.TaggedErrorClass<ProjectMismatchError>()(
  "SessionFolderProjectMismatchError",
  { folder: Schema.String },
) {}

export class TooManyFoldersError extends Schema.TaggedErrorClass<TooManyFoldersError>()("SessionFolderLimitError", {
  count: Schema.Number,
}) {}

export type Error = FolderNotFoundError | ProjectMismatchError | TooManyFoldersError

export type SwitchInput = {
  sessionID: SessionID
  directory: string
  // Extras after the switch, used verbatim (normalized against the new
  // primary). Omitted, the session keeps its extras, led by the old primary
  // when `demote` is set.
  extras?: readonly string[]
  demote?: boolean
  // Reboot the new primary's instance. Without it a loaded instance keeps
  // running and only picks up the new folder union, so a turn running in it
  // survives the switch.
  reload?: boolean
}

export interface Interface {
  // Moves a session's primary folder to another directory of the same
  // project. Same-directory requests are the caller's to short-circuit.
  readonly switchPrimary: (
    input: SwitchInput,
  ) => Effect.Effect<{ previous: string; next: string; extras: string[] }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionFolderSwitch") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const fs = yield* FSUtil.Service
    const projects = yield* ProjectV2.Service
    const projectDirectories = yield* ProjectDirectories.Service
    const sessionFolders = yield* SessionFolders.Service
    const liveFolders = yield* SessionFolders.Live
    const instances = yield* InstanceStore.Service

    const exists = (dir: string) => fs.exists(dir).pipe(Effect.orElseSucceed(() => false))

    const switchPrimary = Effect.fn("SessionFolderSwitch.switchPrimary")(function* (input: SwitchInput) {
      const info = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const next = yield* fs.resolve(input.directory)
      if (!(yield* exists(next))) return yield* new FolderNotFoundError({ folder: input.directory })
      // Primary switch keeps Git identity: the new primary must resolve to
      // the same project, otherwise the session would straddle two project
      // rows, two worktrees, and two drains.
      const nextProject = yield* projects.resolve(AbsolutePath.make(next))
      if (nextProject.id !== info.projectID) return yield* new ProjectMismatchError({ folder: input.directory })
      const others = (yield* sessionFolders.list(input.sessionID)).filter(
        (dir) => dir !== next && dir !== info.directory,
      )
      const extras =
        input.extras === undefined
          ? input.demote
            ? [info.directory, ...others]
            : others
          : normalizeFolders(next, yield* Effect.forEach(input.extras, (dir) => fs.resolve(dir)))
      if (extras.length > MaxExtras) return yield* new TooManyFoldersError({ count: extras.length })
      for (const extra of extras) {
        if (yield* exists(extra)) continue
        return yield* new FolderNotFoundError({ folder: extra })
      }
      yield* sessions.setDirectory({ sessionID: input.sessionID, directory: next })
      // The new primary is a directory of this same project, so it joins
      // the project's directory list; extras stay session-scoped.
      yield* projectDirectories
        .create({ directory: AbsolutePath.make(next), projectID: info.projectID })
        .pipe(Effect.ignore)
      yield* sessionFolders.replace(input.sessionID, extras)
      yield* liveFolders.refresh(info.directory)
      yield* input.reload ? instances.reload({ directory: next }).pipe(Effect.asVoid) : liveFolders.refresh(next)
      return { previous: info.directory, next, extras }
    })

    return Service.of({ switchPrimary })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    FSUtil.node,
    ProjectV2.node,
    ProjectDirectories.node,
    SessionFolders.node,
    InstanceStore.node,
    InstanceStore.foldersNode,
  ],
})
