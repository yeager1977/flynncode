import { Location } from "@opencode-ai/schema/location"
import { Session } from "@opencode-ai/schema/session"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "../errors"

const ImportSource = Schema.Literals(["claude-code", "codex"])

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
        })
        .annotateMerge(
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
    .annotateMerge(
      OpenApi.annotations({
        title: "import",
        description: "Experimental session import routes.",
      }),
    )