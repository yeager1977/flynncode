import { Location } from "@flynncode/schema/location"
import { Session } from "@flynncode/schema/session"
import { NonNegativeInt } from "@flynncode/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "../errors"

export const ImportSource = Schema.Literals(["claude-code", "codex"])

const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  text: Schema.String,
  time: NonNegativeInt,
})

const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  text: Schema.String,
  time: NonNegativeInt,
})

export const ImportedMessage = Schema.Union([UserMessage, AssistantMessage]).annotate({
  identifier: "ImportedMessage",
})
export type ImportedMessage = typeof ImportedMessage.Type

const root = "/api/import"

export const makeImportGroup = () =>
  HttpApiGroup.make("server.import")
    .add(
      HttpApiEndpoint.post("import.session", `${root}/session`, {
        payload: Schema.Struct({
          source: ImportSource,
          sourceSessionID: Schema.String,
          sourcePath: Schema.String,
          title: Schema.String,
          location: Location.Ref,
          transcript: Schema.Array(ImportedMessage),
        }),
        success: Schema.Struct({ data: Session.Info }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.import.session",
          summary: "Import session",
          description: "Create a session at the requested location and append an imported transcript to it.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("import.imported", `${root}/imported`, {
        query: Schema.Struct({
          source: ImportSource,
          directory: Schema.String,
        }),
        success: Schema.Struct({
          data: Schema.Array(
            Schema.Struct({
              sourceSessionID: Schema.String,
              sessionID: Session.ID,
            }),
          ),
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.import.imported",
          summary: "List imported sessions",
          description: "List source session IDs already imported into the given directory.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("import.sources", `${root}/sources`, {
        query: Schema.Struct({
          source: ImportSource,
          directory: Schema.String,
        }),
        success: Schema.Struct({
          data: Schema.Array(
            Schema.Struct({
              path: Schema.String,
              sourceSessionID: Schema.String,
              title: Schema.String,
              cwd: Schema.String,
              time: NonNegativeInt,
              messageCount: NonNegativeInt,
              imported: Schema.Boolean,
            }),
          ),
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.import.sources",
          summary: "List importable sessions",
          description:
            "Discover Claude Code and Codex sessions recorded in the given directory or one of its subdirectories. Sessions from other directories are omitted.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("import.fromSource", `${root}/from-source`, {
        payload: Schema.Struct({
          source: ImportSource,
          sourceSessionID: Schema.String,
          sourcePath: Schema.String,
          title: Schema.String,
          location: Location.Ref,
        }),
        success: Schema.Struct({ data: Session.Info }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.import.fromSource",
          summary: "Import session from source",
          description: "Read a discovered source session, parse it, and import it as a new session.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "import",
        description: "Experimental session import routes.",
      }),
    )
