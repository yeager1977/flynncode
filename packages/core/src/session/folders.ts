export * as SessionFolders from "./folders"

import { and, asc, eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { AbsolutePath } from "../schema"
import { SessionSchema } from "./schema"
import { SessionFolderTable, SessionTable } from "./sql"

export interface Interface {
  /** Extra folders attached to one session, in attach order. */
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<AbsolutePath[]>
  /** Replaces the session's extra folders. Callers validate and normalize first. */
  readonly replace: (sessionID: SessionSchema.ID, extras: readonly string[]) => Effect.Effect<void>
  /**
   * Union of extras across unarchived sessions placed in `directory`. Running
   * instances are shared per directory, so their live file boundary is the
   * union of every session's attachments there.
   */
  readonly forDirectory: (directory: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionFolders") {}

// Hosts that keep live per-directory instances (the opencode runtime) provide
// this so folder changes made through the V2 server reach the running
// instance's file boundary. Standalone servers have no instances and omit it.
export interface LiveInterface {
  readonly refresh: (directory: string) => Effect.Effect<void>
}

export class Live extends Context.Service<Live, LiveInterface>()("@opencode/SessionFolders.Live") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const list = Effect.fn("SessionFolders.list")(function* (sessionID: SessionSchema.ID) {
      const rows = yield* db
        .select({ directory: SessionFolderTable.directory })
        .from(SessionFolderTable)
        .where(eq(SessionFolderTable.session_id, sessionID))
        .orderBy(asc(SessionFolderTable.position))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => AbsolutePath.make(row.directory))
    })

    const replace = Effect.fn("SessionFolders.replace")(function* (
      sessionID: SessionSchema.ID,
      extras: readonly string[],
    ) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(SessionFolderTable).where(eq(SessionFolderTable.session_id, sessionID)).run()
            if (extras.length === 0) return
            yield* tx
              .insert(SessionFolderTable)
              .values(extras.map((directory, position) => ({ session_id: sessionID, directory, position })))
              .run()
          }),
        )
        .pipe(Effect.orDie)
    })

    const forDirectory = Effect.fn("SessionFolders.forDirectory")(function* (directory: string) {
      const rows = yield* db
        .select({ directory: SessionFolderTable.directory })
        .from(SessionFolderTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionFolderTable.session_id))
        .where(and(eq(SessionTable.directory, directory), isNull(SessionTable.time_archived)))
        .orderBy(asc(SessionFolderTable.time_created), asc(SessionFolderTable.position))
        .all()
        .pipe(Effect.orDie)
      return [...new Set(rows.map((row) => row.directory))]
    })

    return Service.of({ list, replace, forDirectory })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
