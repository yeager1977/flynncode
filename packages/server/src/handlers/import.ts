import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionImport } from "@opencode-ai/core/session/import"
import { SessionImportRegistry } from "@opencode-ai/core/session/import-registry"
import { discoverFromHome, resolveSourceFile } from "@opencode-ai/core/session/import-source/discover-node"
import { parseClaudeCode } from "@opencode-ai/core/session/import-source/claude-code"
import { parseCodex } from "@opencode-ai/core/session/import-source/codex"
import { InvalidRequestError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { readFile } from "node:fs/promises"
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
      .handle(
        "import.sources",
        Effect.fn(function* (ctx) {
          const candidates = yield* Effect.promise(() =>
            discoverFromHome({ source: ctx.query.source, home: Global.Path.home }),
          )
          const imported = yield* SessionImportRegistry.findImported(database.db, {
            source: ctx.query.source,
            directory: ctx.query.directory,
          })
          const known = new Set(imported.map((item) => item.sourceSessionID))
          return {
            data: candidates.map((item) => ({
              path: item.path,
              sourceSessionID: item.sourceSessionID,
              title: item.title,
              cwd: item.cwd,
              time: Number.isFinite(item.time) ? Math.max(0, Math.floor(item.time)) : 0,
              messageCount: item.messageCount,
              imported: known.has(item.sourceSessionID),
            })),
          }
        }),
      )
      .handle(
        "import.fromSource",
        Effect.fn(function* (ctx) {
          const resolved = yield* Effect.promise(() =>
            resolveSourceFile({
              source: ctx.payload.source,
              home: Global.Path.home,
              path: ctx.payload.sourcePath,
            }),
          )
          if (!resolved)
            return yield* new InvalidRequestError({
              message: "Source path is not a discovered import candidate",
              field: "sourcePath",
            })

          const text = yield* Effect.promise(() => readFile(resolved.path, "utf8").catch(() => undefined))
          if (text === undefined)
            return yield* new InvalidRequestError({
              message: "Source session could not be read",
              field: "sourcePath",
            })

          const parsed =
            resolved.source === "claude-code" ? parseClaudeCode({ path: resolved.path, text }) : parseCodex({ path: resolved.path, text })
          if (!parsed.messages.length)
            return yield* new InvalidRequestError({
              message: "Source session has no importable messages",
              field: "sourcePath",
            })

          return {
            data: yield* SessionImport.importSession({
              location: ctx.payload.location,
              source: resolved.source,
              sourceSessionID: parsed.sourceSessionID,
              sourcePath: resolved.path,
              title: ctx.payload.title || parsed.title,
              transcript: parsed.messages,
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
  }),
)