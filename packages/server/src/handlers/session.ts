import { SessionV2 } from "@opencode-ai/core/session"
import { SessionFolders } from "@opencode-ai/core/session/folders"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { MaxExtras, normalizeFolders } from "@opencode-ai/core/project/folders"
import { DateTime, Effect, Option, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "@opencode-ai/protocol/groups/session"
import {
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "@opencode-ai/protocol/errors"
import { AbsolutePath } from "@opencode-ai/core/schema"

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const folders = yield* SessionFolders.Service
    const live = yield* Effect.serviceOption(SessionFolders.Live)
    const fs = yield* FSUtil.Service
    const { db } = yield* Database.Service

    const notFound = (sessionID: string) =>
      new SessionNotFoundError({ sessionID, message: `Session not found: ${sessionID}` })

    const requireSession = Effect.fn("SessionHandler.requireSession")(function* (sessionID: SessionV2.ID) {
      return yield* session.get(sessionID).pipe(
        Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(notFound(error.sessionID))),
      )
    })

    // Multifold: the V2 projected Info carries no directory, so the primary
    // folder is read from the session row like session-location does.
    const primaryDirectory = Effect.fn("SessionHandler.primaryDirectory")(function* (sessionID: SessionV2.ID) {
      yield* requireSession(sessionID)
      const row = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(notFound(sessionID))
      return row.directory
    })

    // Multifold: extras ride as an additive session-level field persisted per
    // session. Location.Ref stays the sole placement key.
    const requireExtras = Effect.fn("SessionHandler.requireExtras")(function* (primary: string, raw?: readonly string[]) {
      const extras = normalizeFolders(primary, raw ? [...raw] : [])
      if (extras.length > MaxExtras)
        return yield* new InvalidRequestError({ message: `Up to ${MaxExtras} extra folders`, field: "additionalDirectories" })
      for (const extra of extras) {
        if (yield* fs.exists(extra).pipe(Effect.orElseSucceed(() => false)))
          continue
        return yield* new InvalidRequestError({ message: `Folder not found: ${extra}`, field: "additionalDirectories" })
      }
      return extras
    })

    const persistExtras = Effect.fn("SessionHandler.persistExtras")(function* (
      sessionID: SessionV2.ID,
      primary: string,
      extras: string[],
    ) {
      yield* folders.replace(sessionID, extras)
      if (Option.isSome(live)) yield* live.value.refresh(primary)
    })

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const sessions = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          const location = ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) }
          const extras = yield* requireExtras(location.directory, ctx.payload.additionalDirectories)
          const created = yield* session.create({
            id: ctx.payload.id,
            agent: ctx.payload.agent,
            kind: ctx.payload.kind,
            model: ctx.payload.model,
            location,
          })
          if (extras.length > 0) yield* persistExtras(created.id, location.directory, extras)
          return { data: created }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          return {
            data: Object.fromEntries(
              Array.from(yield* session.active, (sessionID) => [sessionID, { type: "running" as const }]),
            ),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt: ctx.payload.prompt,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
            Effect.catchTag("Session.MessageDecodeError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: error.message,
                  service: `session.compact.${error._tag}`,
                }),
              ),
            ),
            Effect.catchTag("SessionRunnerModel.ModelNotSelectedError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: error.message,
                  service: `session.compact.${error._tag}`,
                }),
              ),
            ),
            Effect.catchTag("SessionRunnerModel.ModelUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: error.message,
                  service: `session.compact.${error._tag}`,
                }),
              ),
            ),
            Effect.catchTag("SessionRunnerModel.VariantUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: error.message,
                  service: `session.compact.${error._tag}`,
                }),
              ),
            ),
            Effect.catchTag("SessionRunnerModel.UnsupportedApiError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: error.message,
                  service: `session.compact.${error._tag}`,
                }),
              ),
            ),
            Effect.catchTag("Integration.Authorization", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: error.message,
                  service: `session.compact.${error._tag}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.history",
        Effect.fn(function* (ctx) {
          return yield* session
            .history({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
              })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.events",
        Effect.fn((ctx) =>
          Effect.succeed(
            session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie),
          ),
        ),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* session.interrupt(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
      // Multifold folders: this V2 protocol route manages extras only. The
      // primary folder is unchanged here; switching primary (with instance
      // reboot and session rebinding) lives on the V1 instance folders
      // route, because V2 has no directory-mutation primitive and a direct
      // row rebind would bypass the event projector.
      .handle(
        "session.folders",
        Effect.fn(function* (ctx) {
          const primary = yield* primaryDirectory(ctx.params.sessionID)
          return {
            primary: AbsolutePath.make(primary),
            extras: yield* folders.list(ctx.params.sessionID),
          }
        }),
      )
      .handle(
        "session.folders.update",
        Effect.fn(function* (ctx) {
          const primary = yield* primaryDirectory(ctx.params.sessionID)
          const resolved = ctx.payload.extras
            ? yield* Effect.forEach(ctx.payload.extras, (dir) => fs.resolve(dir))
            : []
          const extras = yield* requireExtras(primary, resolved)
          yield* persistExtras(ctx.params.sessionID, primary, extras)
          return {
            primary: AbsolutePath.make(primary),
            extras: extras.map((dir) => AbsolutePath.make(dir)),
          }
        }),
      )
  }),
)
