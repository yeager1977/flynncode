import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionImport } from "@opencode-ai/core/session/import"
import { SessionImportRegistry } from "@opencode-ai/core/session/import-registry"
import { SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ImportHandler = HttpApiBuilder.group(Api, "server.import", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const database = yield* Database.Service

    return handlers
      .handle(
        "import.session",
        Effect.fn(function* (ctx) {
          return {
            data: yield* SessionImport.importSession({
              location: ctx.payload.location,
              source: ctx.payload.source,
              sourceSessionID: ctx.payload.sourceSessionID,
              sourcePath: ctx.payload.sourcePath,
              title: ctx.payload.title,
              transcript: ctx.payload.transcript,
            }).pipe(
              Effect.provideService(SessionV2.Service, session),
              Effect.provideService(EventV2.Service, events),
              Effect.provideService(Database.Service, database),
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "import.imported",
        Effect.fn(function* (ctx) {
          const imported = yield* SessionImportRegistry.findImported(database.db, {
            source: ctx.query.source,
            directory: ctx.query.directory,
          })
          return {
            data: imported.map((item) => ({
              sourceSessionID: item.sourceSessionID,
              sessionID: SessionSchema.ID.make(item.sessionID),
            })),
          }
        }),
      )
  }),
)