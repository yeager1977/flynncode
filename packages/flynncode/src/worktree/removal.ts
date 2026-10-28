export * as WorktreeRemoval from "./removal"

import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { FSUtil } from "@flynncode/core/fs-util"
import { SessionTable } from "@flynncode/core/session/sql"
import type { SessionV1 } from "@flynncode/core/v1/session"
import { sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Option, Schedule, Schema, Scope } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Worktree } from "@/worktree"

// A worktree removal exit_worktree decided on. `loss` is what the user
// approved losing for a forced removal (discard_changes).
export const Request = Schema.Struct({
  path: Schema.String,
  // The folder the session went back to; the removal runs in its instance,
  // or in the project's main folder's when that folder is gone.
  home: Schema.String,
  main: Schema.String,
  forced: Schema.Boolean,
  loss: Schema.Array(Schema.String),
})
export type Request = Schema.Schema.Type<typeof Request>

// A removal waiting for its worktree to fall idle, recorded on the session
// so it survives a restart. The tool call it answers gets its final state.
export const Pending = Schema.Struct({
  ...Request.fields,
  messageID: MessageID,
  callID: Schema.optional(Schema.String),
})
export type Pending = Schema.Schema.Type<typeof Pending>

// Session metadata key: pending removals by worktree path.
export const KEY = "worktreeRemovals"

const decodePending = Schema.decodeUnknownOption(Schema.Record(Schema.String, Pending))

export type Outcome = { removed: boolean; reason?: string }

export interface Interface {
  // Whether a session runs in the worktree's instance. Disposing that
  // instance cancels its runs, so a removal waits while one does.
  readonly inUse: (path: string) => Effect.Effect<boolean>
  // Removes the worktree now. Right before deleting it re-checks that the
  // path is a registered worktree of this project and, for a forced
  // removal, that nothing beyond the approved loss would now be lost.
  readonly run: (request: Request) => Effect.Effect<Outcome>
  // Records the removal on the session and completes it once nothing runs
  // in the worktree, after a restart too, then updates the tool call.
  readonly defer: (sessionID: SessionID, pending: Pending) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/WorktreeRemoval") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const worktrees = yield* Worktree.Service
    const store = yield* InstanceStore.Service
    const status = yield* SessionStatus.Service
    const project = yield* Project.Service
    const fs = yield* FSUtil.Service
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    // Removals this process waits on, so one is never completed twice.
    const waiting = new Set<string>()

    const inUse = Effect.fn("WorktreeRemoval.inUse")(function* (path: string) {
      if (!(yield* store.loadedDirectories()).has(FSUtil.resolve(path))) return false
      return (yield* store.provide({ directory: path }, status.list())).size > 0
    })

    const home = Effect.fnUntraced(function* (request: Request) {
      return (yield* fs.existsSafe(request.home)) ? request.home : request.main
    })

    // The worktree service never removes the worktree of the instance it
    // runs in, so this runs in the instance of the folder the session is back in.
    const remove = Effect.fnUntraced(function* (request: Request) {
      const ctx = yield* InstanceState.context
      if (!(yield* fs.existsSafe(request.path))) {
        yield* project.removeSandbox(ctx.project.id, request.path).pipe(Effect.ignore)
        return { removed: true }
      }
      const listed = (yield* worktrees.list().pipe(Effect.orElseSucceed(() => []))).some(
        (entry) => entry.directory === FSUtil.resolve(request.path),
      )
      if (!listed) return { removed: false, reason: `${request.path} is not a registered worktree of this project` }
      if (request.forced) {
        const fresh = (yield* worktrees.losses({ directory: request.path })).filter(
          (item) => !request.loss.includes(item),
        )
        if (fresh.length > 0)
          return {
            removed: false,
            reason: `removing it now would also lose ${fresh.join("; ")}, which was not approved`,
          }
      }
      yield* store.disposeDirectory(request.path)
      const removed = request.forced
        ? yield* worktrees.remove({ directory: request.path })
        : yield* worktrees.disposeIfSafe({ directory: request.path })
      if (!removed) return { removed, reason: "it changed since the check or is still open elsewhere" }
      yield* project.removeSandbox(ctx.project.id, request.path).pipe(Effect.ignore)
      return { removed }
    })

    const run = Effect.fn("WorktreeRemoval.run")(function* (request: Request) {
      const outcome: Outcome = yield* store
        .provide({ directory: yield* home(request) }, remove(request))
        .pipe(Effect.catch((error) => Effect.succeed({ removed: false, reason: error.message })))
      if (!outcome.removed)
        yield* Effect.logWarning("worktree removal kept the worktree", { path: request.path, reason: outcome.reason })
      return outcome
    })

    // Drops the record and shows the final state on the tool call.
    const settle = Effect.fnUntraced(function* (sessionID: SessionID, pending: Pending, outcome: Outcome) {
      const info = yield* sessions.get(sessionID).pipe(Effect.option)
      if (Option.isNone(info)) return
      const rest = Object.entries(recorded(info.value)).filter(([path]) => path !== pending.path)
      const others = Object.entries(info.value.metadata ?? {}).filter(([key]) => key !== KEY)
      yield* sessions.setMetadata({
        sessionID,
        metadata: Object.fromEntries(rest.length > 0 ? [...others, [KEY, Object.fromEntries(rest)]] : others),
      })
      const message = yield* sessions
        .findMessage(sessionID, (item) => item.info.id === pending.messageID)
        .pipe(Effect.orElseSucceed(() => Option.none<SessionV1.WithParts>()))
      if (Option.isNone(message)) return
      const part = message.value.parts.find(
        (item): item is SessionV1.ToolPart =>
          item.type === "tool" &&
          item.tool === "exit_worktree" &&
          (pending.callID === undefined || item.callID === pending.callID),
      )
      if (part?.state.status !== "completed") return
      const shown = part.state.metadata?.worktree
      if (typeof shown !== "object" || shown === null) return
      yield* sessions.updatePart({
        ...part,
        state: {
          ...part.state,
          metadata: {
            ...part.state.metadata,
            worktree: {
              ...Object.fromEntries(Object.entries(shown).filter(([key]) => key !== "pending")),
              removed: outcome.removed,
            },
          },
        },
      })
    })

    const wait = (sessionID: SessionID, pending: Pending) =>
      Effect.suspend(() => {
        const key = `${sessionID}\0${pending.path}`
        if (waiting.has(key)) return Effect.void
        waiting.add(key)
        return inUse(pending.path).pipe(
          Effect.repeat({ schedule: Schedule.spaced("1 second"), while: (running) => running }),
          Effect.andThen(run(pending)),
          Effect.flatMap((outcome) =>
            Effect.gen(function* () {
              yield* store.provide({ directory: yield* home(pending) }, settle(sessionID, pending, outcome))
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("deferred worktree removal failed", { path: pending.path, cause: Cause.pretty(cause) }),
          ),
          Effect.ensuring(Effect.sync(() => waiting.delete(key))),
        )
      })

    const defer = Effect.fn("WorktreeRemoval.defer")(function* (sessionID: SessionID, pending: Pending) {
      const info = yield* sessions.get(sessionID).pipe(Effect.orDie)
      yield* sessions.setMetadata({
        sessionID,
        metadata: { ...info.metadata, [KEY]: { ...recorded(info), [pending.path]: pending } },
      })
      yield* wait(sessionID, pending).pipe(Effect.forkIn(scope))
    })

    // Removals a previous process recorded but did not finish.
    yield* Effect.gen(function* () {
      const rows = yield* db
        .select({ id: SessionTable.id, metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(sql`json_extract(${SessionTable.metadata}, ${`$.${KEY}`}) IS NOT NULL`)
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        rows.flatMap((row) =>
          Object.values(Option.getOrElse(decodePending(row.metadata?.[KEY]), () => ({}))).map((pending) => ({
            sessionID: SessionID.make(row.id),
            pending,
          })),
        ),
        (item) => wait(item.sessionID, item.pending).pipe(Effect.forkIn(scope)),
        { discard: true },
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("pending worktree removals could not be read", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    )

    return Service.of({ inUse, run, defer })
  }),
)

function recorded(info: Session.Info) {
  return Option.getOrElse(decodePending(info.metadata?.[KEY]), () => ({}))
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    Worktree.node,
    InstanceStore.node,
    SessionStatus.node,
    Project.node,
    FSUtil.node,
    Database.node,
  ],
})
